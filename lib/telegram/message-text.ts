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

/** Escapes the characters Telegram's HTML parse mode reads as markup. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Renders the Markdown pi replies in as Telegram HTML (parse_mode=HTML) so
 * **bold**, *italic*, `code`, ```fences```, [links](url) and # headings show
 * as real formatting instead of literal asterisks and backticks. The text is
 * escaped first and only paired markers convert, so the output is always
 * well-formed HTML; unmatched markers stay as plain characters. Underscore
 * emphasis is deliberately not converted (snake_case would mangle).
 */
export function markdownToTelegramHtml(text: string): string {
  // Fenced blocks leave first: their content must survive the later passes.
  const blocks: string[] = [];
  let out = text.replace(/```[a-zA-Z0-9+#-]*\n?([\s\S]*?)```/g, (_match, code: string) => {
    blocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  out = escapeHtml(out);
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  // The lookarounds keep a lone * from pairing with one half of a ** pair.
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
  out = out.replace(/^#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>");
  // Telegram has no list markup; a leading -/*/+ reads as a stray hyphen, so
  // bullets become real • characters (indent kept for nesting). Runs after
  // the emphasis passes, so paired * are gone and only markers remain.
  out = out.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");
  return out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => blocks[Number(index)] ?? "");
}

/** The greeting/status footer commands append, kept short for one message. */
export function firstChatTitle(title: string | null, chatId: number): string {
  return title?.trim() ? title.trim() : `chat ${chatId}`;
}
