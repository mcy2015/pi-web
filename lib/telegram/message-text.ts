// Pure helpers for Telegram message shaping. Tested in message-text.test.mjs.

/** Any pi message shape the bridge meets: string or block-array content. */
export interface TextCarryingMessage {
  role: string;
  content: unknown;
}

/** Telegram's hard limit for sendMessage. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * The text of a pi message: a string content directly, or the text blocks of
 * a block array joined with blank lines (thinking blocks are not chat prose).
 */
export function agentMessageText(message: TextCarryingMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        block && typeof block === "object" && !Array.isArray(block)
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.join("\n\n");
  }
  return "";
}

/**
 * Splits a reply into Telegram-sized chunks. Prefers breaking on paragraph,
 * then line, then word boundaries; a longer unbroken line is hard-split at
 * the limit. Chunk order matches the text order.
 */
export function splitForTelegram(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );
    const at = cut > 0 ? cut : limit;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\s+/, "");
  }
  if (rest !== "") chunks.push(rest);
  return chunks;
}

/** The greeting/status footer commands append, kept short for one message. */
export function firstChatTitle(title: string | null, chatId: number): string {
  return title?.trim() ? title.trim() : `chat ${chatId}`;
}
