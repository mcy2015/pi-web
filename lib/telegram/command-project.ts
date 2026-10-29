// /project for the Telegram channel: switch the chat's working folder through
// an inline menu of the projects the session catalogue knows — sessions
// grouped by their project root, freshest first, the chat's current folder
// pinned on top. The chosen folder becomes this chat's cwd override in the
// channels config and a fresh session starts there immediately, so the next
// turn runs in the new folder.

import { basename } from "node:path";
import { sendMessage } from "./bot-api";
import { editTelegramConfig, readTelegramState, type TelegramConfig } from "./config-store";
import { resolveChatCwd, resetChatSession } from "./session-bridge";
import { buildMenuKeyboard, newMenuToken, type MenuOption, type TelegramMenuRegistry } from "./menus";
import { listAllSessions } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";

const TURN_RUNNING_NOTICE = "⏳ A turn is running — try again after it finishes.";

/** Ten rows plus the pinned current folder keep the numbered list readable. */
const MAX_PROJECT_ROWS = 10;

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

/**
 * The roots the menu offers: sessions grouped by projectRoot (the shared git
 * root, the cwd for non-git folders), each root stamped with its newest
 * session's modified time, newest first and capped.
 */
async function listProjectRoots(): Promise<string[]> {
  const sessions = await listAllSessions();
  const latestByRoot = new Map<string, string>();
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    const latest = latestByRoot.get(root);
    if (latest === undefined || session.modified > latest) latestByRoot.set(root, session.modified);
  }
  return [...latestByRoot.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, MAX_PROJECT_ROWS)
    .map(([root]) => root);
}

/**
 * Sends the project menu. Buttons carry only the folder's basename (they
 * truncate anyway), so the message above lists the full paths numbered.
 */
export async function handleProjectCommand(
  token: string,
  chatId: number,
  config: TelegramConfig,
  registry: TelegramMenuRegistry,
): Promise<void> {
  const current = await resolveChatCwd(config, chatId);
  if (current === null) {
    await notice(token, chatId, "❌ The working directory could not be created.");
    return;
  }
  let roots: string[];
  try {
    roots = await listProjectRoots();
  } catch (error) {
    await notice(token, chatId, `❌ Listing projects failed: ${errorText(error)}`);
    return;
  }
  // The current folder stays reachable even when nothing ran there recently.
  if (!roots.includes(current)) roots.unshift(current);
  const options: MenuOption[] = roots.map((root) => ({ id: root, label: basename(root) }));
  const text = [
    "📂 Pick this chat's folder — a new session starts there:",
    ...roots.map((root, index) => `${index + 1}. ${root}`),
  ].join("\n");
  const menuToken = newMenuToken();
  const keyboard = buildMenuKeyboard("project", menuToken, options, { currentId: current });
  try {
    const sent = await sendMessage(token, chatId, text, { replyMarkup: { inline_keyboard: keyboard } });
    registry.issue(chatId, "project", options, sent.message_id, menuToken);
  } catch (error) {
    console.warn(`[pi-web] telegram chat ${chatId}: sending the project menu failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type ProjectMenuOutcome =
  | { applied: true; text: string } // the runtime answers ✓ and edits the menu message to "✓ <text>"
  | { applied: false; text: string }; // a notice shown as-is (⏳/❌ prefixed)

/**
 * Applies a pressed project-menu button: rewrites the chat's cwd override in
 * the config (title and every other field kept) and starts a fresh session
 * there. A turn in flight is refused — the binding may have changed since
 * the menu was issued, so the live wrapper is checked like /stop does.
 * Returns null when the index is out of range; nothing was applied.
 */
export async function applyProjectMenuSelection(
  chatId: number,
  config: TelegramConfig,
  index: number,
  options: MenuOption[],
): Promise<ProjectMenuOutcome | null> {
  const option = options[index];
  if (option === undefined) return null;
  const target = option.id;
  const binding = readTelegramState().chats[String(chatId)];
  if (binding ? getRpcSession(binding.sessionId)?.isRunning() === true : false) {
    return { applied: false, text: TURN_RUNNING_NOTICE };
  }
  if (!config.allowedChats.some((chat) => chat.id === chatId)) {
    return { applied: false, text: "❌ This chat is no longer allowlisted." };
  }
  const current = await resolveChatCwd(config, chatId);
  if (current === null) {
    return { applied: false, text: "❌ The working directory could not be created." };
  }
  if (current === target) {
    return { applied: true, text: `Already in ${basename(target)}` };
  }
  let updated: TelegramConfig;
  try {
    updated = await editTelegramConfig((cfg) => ({
      config: {
        ...cfg,
        allowedChats: cfg.allowedChats.map((chat) => (chat.id === chatId ? { ...chat, cwd: target } : chat)),
      },
      changed: true,
    }));
  } catch (error) {
    return { applied: false, text: `❌ Saving the folder failed: ${errorText(error)}` };
  }
  const reset = await resetChatSession(chatId, updated);
  if (reset.error) return { applied: false, text: `❌ ${reset.error}` };
  return { applied: true, text: `📂 Now in ${basename(target)} — new session started` };
}
