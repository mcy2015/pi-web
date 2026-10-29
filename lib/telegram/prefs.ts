// Per-chat reply granularity for the Telegram channel: whether a turn
// streams a live preview (the channel's long-standing behavior), arrives
// only once finished, or streams plus a tool-call digest. The preference is
// persisted in the channels state file next to the chat's session binding —
// not the config, which belongs to Settings — and is read once per turn at
// dispatch time, so a change lands from the NEXT turn.

import { editTelegramState, readTelegramState } from "./config-store";

export type ReplyMode = "stream" | "final" | "tools";

export const REPLY_MODE_OPTIONS: { id: ReplyMode; label: string }[] = [
  { id: "stream", label: "Streaming — live preview" },
  { id: "final", label: "Final reply only" },
  { id: "tools", label: "Streaming + tool digest" },
];

/** The chat's reply mode; "stream" (the previous behavior) wherever nothing is set. */
export function readChatReplyMode(chatId: number): ReplyMode {
  return readTelegramState().replyModes?.[String(chatId)] ?? "stream";
}

export async function setChatReplyMode(chatId: number, mode: ReplyMode): Promise<void> {
  const key = String(chatId);
  await editTelegramState((state) => {
    if (state.replyModes?.[key] === mode) return { state, changed: false };
    return {
      state: { ...state, replyModes: { ...state.replyModes, [key]: mode } },
      changed: true,
    };
  });
}
