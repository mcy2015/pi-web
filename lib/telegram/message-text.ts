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

// ---- Markdown pipe tables ----
// sendMessage's parse modes have no table entity, so a table either goes out
// as a rich message (Bot API 10.1 sendRichMessage renders Markdown tables
// natively) or, as the fallback, is reshaped into a vertical list here.

/** A fenced code block, extracted so later passes cannot touch its content. */
const FENCED_BLOCK = /```[\s\S]*?```/g;

/** A table's first row: starts with a pipe and has at least one column. */
function isTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.indexOf("|", 1) !== -1;
}

/** The divider row under a table header: only pipes, dashes, colons, spaces. */
function isTableDividerLine(line: string): boolean {
  return /^[\s|:-]*-[\s|:-]*$/.test(line.trim()) && line.includes("-");
}

/** Splits a table row into cells, honouring the escaped pipe \|. */
function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body
    .replace(/\\\|/g, "\u0003")
    .split("|")
    .map((cell) => cell.trim().replace(/\u0003/g, "|"));
}

/** True when the text holds a Markdown pipe table (fenced code excluded). */
export function hasMarkdownTable(text: string): boolean {
  const lines = text.replace(FENCED_BLOCK, "").split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    if (isTableRowLine(lines[i]) && isTableDividerLine(lines[i + 1])) return true;
  }
  return false;
}

/** One table row as a vertical list entry: the first column bold, the rest labeled. */
function verticalTableRow(headers: string[], cells: string[]): string {
  const lines: string[] = [];
  const lead = cells[0] ?? "";
  if (lead !== "") lines.push(`**${lead}**`);
  for (let c = 1; c < cells.length; c++) {
    const value = cells[c];
    if (value === "" && (headers[c] ?? "") === "") continue;
    lines.push(headers[c] ? `${headers[c]}: ${value}` : value);
  }
  return lines.join("\n");
}

/** Replaces every pipe table in the text with a vertical list. */
function tablesToVerticalLists(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isTableRowLine(lines[i]) && i + 1 < lines.length && isTableDividerLine(lines[i + 1])) {
      const headers = splitTableRow(lines[i]);
      i += 2;
      const rendered: string[] = [];
      while (i < lines.length && isTableRowLine(lines[i])) {
        const row = verticalTableRow(headers, splitTableRow(lines[i]));
        if (row !== "") rendered.push(row);
        i++;
      }
      if (rendered.length > 0) out.push(rendered.join("\n\n"), "");
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}

/**
 * Prepares Markdown for a rich message's markdown field. Rich Markdown reads
 * `_text_` as italic, so a bare snake_case word would lose its underscores;
 * such tokens become code spans. Code spans, fenced blocks, links and the
 * emphasis markers themselves keep their underscores.
 */
export function protectUnderscoresForRichMarkdown(text: string): string {
  const fences: string[] = [];
  let out = text.replace(FENCED_BLOCK, (match) => {
    fences.push(match);
    return `\u0000${fences.length - 1}\u0000`;
  });
  const codes: string[] = [];
  out = out.replace(/`[^`\n]+`/g, (match) => {
    codes.push(match);
    return `\u0001${codes.length - 1}\u0001`;
  });
  const links: string[] = [];
  out = out.replace(/\[[^\]\n]*\]\([^)\n]*\)/g, (match) => {
    links.push(match);
    return `\u0002${links.length - 1}\u0002`;
  });
  out = out
    .split(/(\s+)/)
    .map((token) =>
      // Identifier-ish words (letters, digits, path characters) with an inner
      // underscore become code spans; leading/trailing underscores are
      // emphasis syntax (_italic_, __bold__) and stay untouched.
      token.replace(/[A-Za-z0-9._~/@-]+/g, (word) => {
        if (!word.includes("_")) return word;
        if (word.startsWith("_") || word.endsWith("_")) return word;
        return `\`${word}\``;
      }),
    )
    .join("");
  out = out.replace(/\u0002(\d+)\u0002/g, (_match, index: string) => links[Number(index)] ?? "");
  out = out.replace(/\u0001(\d+)\u0001/g, (_match, index: string) => codes[Number(index)] ?? "");
  return out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => fences[Number(index)] ?? "");
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
  out = tablesToVerticalLists(out);
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
