// /model and /think for the Telegram channel: both render an inline-keyboard
// menu (lib/telegram/menus.ts) and apply the pressed option to the chat's pi
// session. A menu is only a snapshot of the listing at issue time — applying
// re-validates against the live session (a /new in between must surface as a
// notice, never silently land elsewhere), and while a turn runs both the
// commands and their buttons refuse rather than switch anything mid-run.

import { sendMessage } from "./bot-api";
import type { TelegramConfig } from "./config-store";
import { resolveChatCwd, withChatWrapper } from "./session-bridge";
import { listChatModels, type ChatModelList } from "./model-listing";
import { buildMenuKeyboard, newMenuToken, type MenuOption, type TelegramMenuRegistry } from "./menus";

const TURN_RUNNING_NOTICE = "⏳ A turn is running — try again after it finishes.";

/** Telegram caps a keyboard at 100 buttons; 12 model rows keep the numbered list readable, and /model <text> narrows longer lists. */
const MAX_MODEL_ROWS = 12;

type ChatModel = ChatModelList["models"][number];

/**
 * A model option's id is `provider/modelId`, split on the FIRST "/" when
 * applied — neither pi provider ids nor model ids contain one.
 */
function modelOptionId(model: { id: string; provider: string }): string {
  return `${model.provider}/${model.id}`;
}

function modelDisplayName(model: ChatModel): string {
  return model.name.trim() !== "" ? model.name : model.id;
}

function modelButtonLabel(model: ChatModel): string {
  return `${modelDisplayName(model)} · ${model.provider}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sends a short plain-text notice; like the runtime's reply(), a failure is logged, never thrown. */
async function notice(token: string, chatId: number, text: string): Promise<void> {
  try {
    await sendMessage(token, chatId, text);
  } catch (error) {
    console.warn(`[pi-web] telegram chat ${chatId}: sending a notice failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The live session state a menu needs: the busy guard and the current model. */
async function readMenuSessionState(
  chatId: number,
  config: TelegramConfig,
): Promise<{ busy: true } | { busy: false; model: { id: string; provider: string } | null; thinkingLevel: string } | { error: string }> {
  return withChatWrapper(chatId, config, async (wrapper) => {
    if (wrapper.isRunning()) return { busy: true as const };
    const state = await wrapper.send({ type: "get_state" }) as {
      model?: { id?: unknown; provider?: unknown };
      thinkingLevel?: unknown;
    };
    const model = state.model;
    return {
      busy: false as const,
      model: model && typeof model.id === "string" && typeof model.provider === "string"
        ? { id: model.id, provider: model.provider }
        : null,
      thinkingLevel: typeof state.thinkingLevel === "string" ? state.thinkingLevel : "off",
    };
  });
}

/**
 * Sends the model menu: the buttons carry the truncated names, the message
 * above them lists the full names numbered so a cut button stays
 * understandable, and the session's current model gets the ✅ marker.
 */
async function sendModelMenu(
  token: string,
  chatId: number,
  config: TelegramConfig,
  registry: TelegramMenuRegistry,
  models: ChatModel[],
  moreCount: number,
): Promise<void> {
  const state = await readMenuSessionState(chatId, config);
  if ("error" in state) {
    await notice(token, chatId, `❌ ${state.error}`);
    return;
  }
  if (state.busy) {
    await notice(token, chatId, TURN_RUNNING_NOTICE);
    return;
  }
  const capped = models.slice(0, MAX_MODEL_ROWS);
  const options: MenuOption[] = capped.map((model) => ({ id: modelOptionId(model), label: modelButtonLabel(model) }));
  const text = [
    "🤖 Pick a model:",
    ...capped.map((model, index) => `${index + 1}. ${modelDisplayName(model)} (${model.provider})`),
    ...(moreCount > 0 ? [`${moreCount} more — narrow the list with /model <name>.`] : []),
  ].join("\n");
  const menuToken = newMenuToken();
  const keyboard = buildMenuKeyboard("model", menuToken, options, {
    currentId: state.model !== null ? modelOptionId(state.model) : undefined,
  });
  try {
    const sent = await sendMessage(token, chatId, text, { replyMarkup: { inline_keyboard: keyboard } });
    registry.issue(chatId, "model", options, sent.message_id, menuToken);
  } catch (error) {
    console.warn(`[pi-web] telegram chat ${chatId}: sending the model menu failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * /model with no argument lists every visible model; with an argument it
 * case-insensitively matches the name, id or provider: exactly one match
 * applies immediately, none replies a notice, several open the menu filtered
 * to the matches.
 */
export async function handleModelCommand(
  token: string,
  chatId: number,
  config: TelegramConfig,
  arg: string,
  registry: TelegramMenuRegistry,
): Promise<void> {
  const cwd = await resolveChatCwd(config, chatId);
  if (cwd === null) {
    await notice(token, chatId, "❌ The working directory could not be created.");
    return;
  }
  let listing: ChatModelList;
  try {
    listing = await listChatModels(cwd);
  } catch (error) {
    await notice(token, chatId, `❌ Loading the model list failed: ${errorText(error)}`);
    return;
  }
  if (listing.models.length === 0) {
    await notice(token, chatId, "❌ No models are available.");
    return;
  }
  const needle = arg.trim().toLowerCase();
  if (needle === "") {
    await sendModelMenu(token, chatId, config, registry, listing.models, listing.models.length - Math.min(listing.models.length, MAX_MODEL_ROWS));
    return;
  }
  const matches = listing.models.filter((model) =>
    model.name.toLowerCase().includes(needle)
    || model.id.toLowerCase().includes(needle)
    || model.provider.toLowerCase().includes(needle));
  if (matches.length === 1) {
    await notice(token, chatId, await applyModelDirect(chatId, config, matches[0]));
    return;
  }
  if (matches.length === 0) {
    await notice(token, chatId, `No model matches “${arg.trim()}”. Use /model to list them.`);
    return;
  }
  await sendModelMenu(token, chatId, config, registry, matches, 0);
}

/** /think: the current model's supported levels as a menu, the current one marked. */
export async function handleThinkCommand(
  token: string,
  chatId: number,
  config: TelegramConfig,
  registry: TelegramMenuRegistry,
): Promise<void> {
  const state = await readMenuSessionState(chatId, config);
  if ("error" in state) {
    await notice(token, chatId, `❌ ${state.error}`);
    return;
  }
  if (state.busy) {
    await notice(token, chatId, TURN_RUNNING_NOTICE);
    return;
  }
  const model = state.model;
  if (model === null) {
    await notice(token, chatId, "The current model has no thinking levels.");
    return;
  }
  const cwd = await resolveChatCwd(config, chatId);
  if (cwd === null) {
    await notice(token, chatId, "❌ The working directory could not be created.");
    return;
  }
  let listing: ChatModelList;
  try {
    listing = await listChatModels(cwd);
  } catch (error) {
    await notice(token, chatId, `❌ Loading the model list failed: ${errorText(error)}`);
    return;
  }
  const levels = listing.thinkingLevels[`${model.provider}:${model.id}`];
  if (!levels || levels.length === 0) {
    await notice(token, chatId, "The current model has no thinking levels.");
    return;
  }
  const options: MenuOption[] = levels.map((level) => ({ id: level, label: level }));
  const shown = listing.models.find((entry) => entry.provider === model.provider && entry.id === model.id);
  const text = `🧠 Thinking level for ${shown ? modelDisplayName(shown) : `${model.provider}/${model.id}`}:`;
  const menuToken = newMenuToken();
  const keyboard = buildMenuKeyboard("think", menuToken, options, { currentId: state.thinkingLevel });
  try {
    const sent = await sendMessage(token, chatId, text, { replyMarkup: { inline_keyboard: keyboard } });
    registry.issue(chatId, "think", options, sent.message_id, menuToken);
  } catch (error) {
    console.warn(`[pi-web] telegram chat ${chatId}: sending the thinking menu failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Applies one model directly (the /model <name> single-match path), answering with the menu's result line. */
async function applyModelDirect(chatId: number, config: TelegramConfig, model: ChatModel): Promise<string> {
  const result = await withChatWrapper(chatId, config, async (wrapper): Promise<{ line: string }> => {
    if (wrapper.isRunning()) return { line: TURN_RUNNING_NOTICE };
    try {
      await wrapper.send({ type: "set_model", provider: model.provider, modelId: model.id });
    } catch (error) {
      return { line: `❌ Switching the model failed: ${errorText(error)}` };
    }
    return { line: `Model set to ${modelButtonLabel(model)}` };
  });
  return "error" in result ? `❌ ${result.error}` : result.line;
}

export type ModelMenuOutcome =
  | { applied: true; text: string } // the runtime answers ✓ and edits the menu message to "✓ <text>"
  | { applied: false; text: string }; // a notice shown as-is (⏳/❌ prefixed)

/**
 * Applies a pressed model/think menu button to the chat's session. The stored
 * option id is applied as it was issued (a /new since issuing still binds the
 * chat to a session in the same cwd, and a model that vanished underneath the
 * menu makes set_model fail into a notice); a turn in flight is refused.
 * Returns null when the index is out of range — nothing was applied.
 */
export async function applyModelMenuSelection(
  chatId: number,
  config: TelegramConfig,
  kind: "model" | "think",
  index: number,
  options: MenuOption[],
): Promise<ModelMenuOutcome | null> {
  const option = options[index];
  if (option === undefined) return null;
  const result = await withChatWrapper(chatId, config, async (wrapper): Promise<{ applied: boolean; line: string }> => {
    if (wrapper.isRunning()) return { applied: false, line: TURN_RUNNING_NOTICE };
    if (kind === "model") {
      // Split on the FIRST "/": neither provider ids nor model ids contain one.
      const slash = option.id.indexOf("/");
      try {
        await wrapper.send({
          type: "set_model",
          provider: option.id.slice(0, slash),
          modelId: option.id.slice(slash + 1),
        });
      } catch (error) {
        return { applied: false, line: `❌ Switching the model failed: ${errorText(error)}` };
      }
      return { applied: true, line: `Model set to ${option.label}` };
    }
    try {
      await wrapper.send({ type: "set_thinking_level", level: option.id });
    } catch (error) {
      return { applied: false, line: `❌ Setting the thinking level failed: ${errorText(error)}` };
    }
    return { applied: true, line: `Thinking level set to ${option.id}` };
  });
  if ("error" in result) return { applied: false, text: `❌ ${result.error}` };
  return { applied: result.applied, text: result.line };
}
