// /reply for the Telegram channel: picks how this chat's turns are answered —
// a live streaming preview (the default), the finished reply only, or
// streaming plus a tool-call digest line. The preference (lib/telegram/prefs)
// is read once per turn at dispatch, so final/tools apply from the NEXT turn;
// a turn already running keeps the behavior it started with. No session is
// touched, so unlike /model there is no busy guard.

import { sendMessage } from "./bot-api";
import type { TelegramConfig } from "./config-store";
import { REPLY_MODE_OPTIONS, readChatReplyMode, setChatReplyMode, type ReplyMode } from "./prefs";
import { buildMenuKeyboard, newMenuToken, type MenuOption, type TelegramMenuRegistry } from "./menus";

const REPLY_MODE_EXPLANATIONS: Record<ReplyMode, string> = {
  stream: "A live preview streams while the reply builds.",
  final: "No streaming preview; the completed reply arrives as one message.",
  tools: "A live preview streams; the finished reply ends with a digest of the tools it called.",
};

/**
 * Sends the reply-mode menu: the current mode gets the ✅ marker, and the
 * message spells out when a change takes effect (the next turn). The config
 * parameter is unused — the modes are runtime state, not Settings — but the
 * signature matches the other menu commands.
 */
export async function handleReplyCommand(
  token: string,
  chatId: number,
  config: TelegramConfig,
  registry: TelegramMenuRegistry,
): Promise<void> {
  const options: MenuOption[] = REPLY_MODE_OPTIONS.map((mode) => ({ id: mode.id, label: mode.label }));
  const text = [
    "💬 How should replies arrive?",
    ...REPLY_MODE_OPTIONS.map((mode, index) => `${index + 1}. ${mode.label} — ${REPLY_MODE_EXPLANATIONS[mode.id]}`),
    "Applies from your next message; a turn already running keeps its behavior.",
  ].join("\n");
  const menuToken = newMenuToken();
  const keyboard = buildMenuKeyboard("reply", menuToken, options, { currentId: readChatReplyMode(chatId) });
  try {
    const sent = await sendMessage(token, chatId, text, { replyMarkup: { inline_keyboard: keyboard } });
    registry.issue(chatId, "reply", options, sent.message_id, menuToken);
  } catch (error) {
    console.warn(`[pi-web] telegram chat ${chatId}: sending the reply menu failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type ReplyMenuOutcome =
  | { applied: true; text: string } // the runtime answers ✓ and edits the menu message to "✓ <text>"
  | { applied: false; text: string }; // a notice shown as-is (❌ prefixed)

/**
 * Applies a pressed reply-menu button: persists the chat's mode. Returns
 * null when the index is out of range or the stored id is not one of the
 * three modes — nothing was applied.
 */
export async function applyReplyMenuSelection(
  chatId: number,
  index: number,
  options: MenuOption[],
): Promise<ReplyMenuOutcome | null> {
  const option = options[index];
  if (option === undefined) return null;
  const mode = REPLY_MODE_OPTIONS.find((entry) => entry.id === option.id);
  if (!mode) return null;
  await setChatReplyMode(chatId, mode.id);
  return {
    applied: true,
    text: `Replies: ${mode.label}${mode.id === "stream" ? "" : " (from your next message)"}`,
  };
}
