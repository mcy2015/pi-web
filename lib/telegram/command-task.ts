// /task for the Telegram channel: switch this chat back to an earlier pi
// session that ran in the same folder, through the inline menu. The menu
// lists the folder's sessions freshest first (subagents hidden — they belong
// to their parent's story); pressing one rebinds the chat to that session,
// verifying it actually reopens before the binding is kept.

import { basename } from "node:path";
import { sendMessage } from "./bot-api";
import { editTelegramState, readTelegramState, type TelegramConfig } from "./config-store";
import { resolveChatCwd, withChatGate } from "./session-bridge";
import { buildMenuKeyboard, newMenuToken, type MenuOption, type TelegramMenuRegistry } from "./menus";
import { listAllSessions } from "@/lib/session-reader";
import type { SessionInfo } from "@/lib/types";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";

const TURN_RUNNING_NOTICE = "⏳ A turn is running — try again after it finishes.";

/** Eight rows keep the numbered list (label + id + date) readable on phones. */
const MAX_TASK_ROWS = 8;

const LABEL_MAX_CHARS = 40;

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

/** A session's menu label: its name or first message, first line only, whitespace collapsed, capped. */
function sessionLabel(session: SessionInfo): string {
  const firstLine = (session.name ?? session.firstMessage ?? "").trim().split("\n")[0].replace(/\s+/g, " ").trim();
  const label = firstLine !== "" ? firstLine : "(no messages)";
  return label.length > LABEL_MAX_CHARS ? `${label.slice(0, LABEL_MAX_CHARS - 1)}…` : label;
}

/**
 * Sends the task menu: the folder's earlier sessions, freshest first. The
 * buttons carry only the truncated labels, so the message above repeats each
 * row with the session's short id and modified date to keep a cut button
 * identifiable; the chat's currently bound session gets the ✅ marker.
 */
export async function handleTaskCommand(
  token: string,
  chatId: number,
  config: TelegramConfig,
  registry: TelegramMenuRegistry,
): Promise<void> {
  const folder = await resolveChatCwd(config, chatId);
  if (folder === null) {
    await notice(token, chatId, "❌ The working directory could not be created.");
    return;
  }
  let candidates: SessionInfo[];
  try {
    const sessions = await listAllSessions();
    candidates = sessions
      .filter((session) => session.cwd === folder && session.relation?.kind !== "subagent")
      .sort((a, b) => b.modified.localeCompare(a.modified))
      .slice(0, MAX_TASK_ROWS);
  } catch (error) {
    await notice(token, chatId, `❌ Listing sessions failed: ${errorText(error)}`);
    return;
  }
  if (candidates.length === 0) {
    await notice(token, chatId, "No earlier sessions in this folder — send a message to start one.");
    return;
  }
  const options: MenuOption[] = candidates.map((session) => ({ id: session.id, label: sessionLabel(session) }));
  const currentId = readTelegramState().chats[String(chatId)]?.sessionId ?? null;
  const text = [
    `↩️ Switch this chat to an earlier session in ${basename(folder)}:`,
    ...candidates.map((session, index) =>
      `${index + 1}. ${sessionLabel(session)} — ${session.id.slice(0, 8)} · ${session.modified.slice(0, 10)}`),
  ].join("\n");
  const menuToken = newMenuToken();
  const keyboard = buildMenuKeyboard("task", menuToken, options, { currentId: currentId ?? undefined });
  try {
    const sent = await sendMessage(token, chatId, text, { replyMarkup: { inline_keyboard: keyboard } });
    registry.issue(chatId, "task", options, sent.message_id, menuToken);
  } catch (error) {
    console.warn(`[pi-web] telegram chat ${chatId}: sending the task menu failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type TaskMenuOutcome =
  | { applied: true; text: string } // the runtime answers ✓ and edits the menu message to "✓ <text>"
  | { applied: false; text: string }; // a notice shown as-is (⏳/❌ prefixed)

/**
 * Applies a pressed task-menu button: rebinds the chat to the chosen session.
 * The whole switch holds the chat gate — openBoundSession's bind/reopen phase
 * runs inside that same gate (from withChatWrapper and every turn), so a
 * message arriving mid-switch cannot interleave its own bind with ours, and
 * checking isRunning inside the gate closes the phase-1 race (a turn whose
 * prompt was just accepted is already running by the time we hold the gate).
 * The reopen verification sits in the gate too, exactly where the bridge
 * reopens a bound session, so a failure rolls the binding back before
 * anything else observes it. Returns null when the index is out of range;
 * nothing was applied.
 */
export async function applyTaskMenuSelection(
  chatId: number,
  config: TelegramConfig,
  index: number,
  options: MenuOption[],
): Promise<TaskMenuOutcome | null> {
  const option = options[index];
  if (option === undefined) return null;
  return withChatGate(chatId, async (): Promise<TaskMenuOutcome> => {
    const binding = readTelegramState().chats[String(chatId)];
    if (binding ? getRpcSession(binding.sessionId)?.isRunning() === true : false) {
      return { applied: false, text: TURN_RUNNING_NOTICE };
    }
    let found: SessionInfo | undefined;
    try {
      const sessions = await listAllSessions();
      found = sessions.find((session) => session.id === option.id && session.relation?.kind !== "subagent");
    } catch (error) {
      return { applied: false, text: `❌ Listing sessions failed: ${errorText(error)}` };
    }
    if (!found) return { applied: false, text: "❌ Could not reopen that session." };
    const chosen = found;
    const folder = await resolveChatCwd(config, chatId);
    if (folder === null || chosen.cwd !== folder) {
      // /project moved the chat since the menu was issued; a stale press must
      // not drag a session from the old folder back in.
      return { applied: false, text: "❌ The chat's folder changed — open /task again." };
    }
    const success: TaskMenuOutcome = { applied: true, text: `↩️ Switched to ${sessionLabel(chosen)} (${chosen.id.slice(0, 8)})` };
    if (binding && binding.sessionId === chosen.id) return success;
    try {
      await editTelegramState((state) => ({
        state: {
          ...state,
          chats: { ...state.chats, [String(chatId)]: { sessionId: chosen.id, sessionFile: chosen.path } },
        },
        changed: true,
      }));
    } catch (error) {
      return { applied: false, text: `❌ Saving the binding failed: ${errorText(error)}` };
    }
    try {
      const alive = getRpcSession(chosen.id);
      if (!alive?.isAlive()) await startRpcSession(chosen.id, chosen.path, undefined);
    } catch (error) {
      console.warn(`[pi-web] telegram chat ${chatId}: reopening ${chosen.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      // Roll the binding back to what it was (or away, when none existed).
      await editTelegramState((state) => {
        const chats = { ...state.chats };
        if (binding) chats[String(chatId)] = binding;
        else delete chats[String(chatId)];
        return { state: { ...state, chats }, changed: true };
      }).catch(() => {});
      return { applied: false, text: "❌ Could not reopen that session." };
    }
    return success;
  });
}
