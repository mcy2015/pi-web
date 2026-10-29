// Pure classification and prompt building for Telegram document
// attachments (message.document — files sent as files, not photos). The
// runtime classifies before downloading, so an unsupported file costs one
// refusal reply and no traffic; nothing here touches the Bot API, keeping
// the rules testable on their own.

/** What an update's document field tells us; every field optional like Telegram sends it. */
export interface DocumentInput {
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

export type DocumentClassification =
  | { kind: "image" } // downloadable and runnable with vision, like a photo
  | { kind: "text" } // inlined into the prompt as a fenced block
  | { kind: "unsupported"; reason: "type" | "size" | "binary" };

/** Text kinds are inlined into the prompt; past this the reply itself would drown in the file. */
export const MAX_DOCUMENT_BYTES = 1_048_576;

/**
 * File names (lowercase) whose extension — or, for extension-less names like
 * `Makefile`, the whole basename — marks a file as text.
 */
const TEXT_FILE_NAMES = new Set([
  "txt", "md", "markdown", "json", "jsonc", "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "rs", "go", "java", "kt", "c", "h", "cpp", "hpp", "cs", "php",
  "sh", "bash", "zsh", "fish", "yml", "yaml", "toml", "ini", "cfg", "conf", "env",
  "csv", "tsv", "log", "xml", "html", "css", "scss", "sql", "gitignore", "dockerfile", "makefile",
]);

/** The lowercase extension of a name, or the whole basename when it has none (`Makefile`, `.gitignore`). */
function fileNameKey(fileName: string): string {
  const lowered = fileName.trim().toLowerCase();
  const dot = lowered.lastIndexOf(".");
  return dot === -1 ? lowered : lowered.slice(dot + 1);
}

/**
 * One deterministic pass: size first (an oversized file is refused whatever
 * its type — the size message points at photos for big images), then image
 * mimes, then text by mime or file name, and `application/octet-stream` is
 * called out as binary while anything else unrecognised is a plain type
 * refusal. Both refusals get the same reply; the split exists for tests.
 */
export function classifyDocument(doc: DocumentInput): DocumentClassification {
  if (doc.fileSize !== undefined && doc.fileSize > MAX_DOCUMENT_BYTES) {
    return { kind: "unsupported", reason: "size" };
  }
  const mime = doc.mimeType?.trim().toLowerCase();
  if (mime !== undefined && mime.startsWith("image/")) {
    return { kind: "image" };
  }
  const textMime = mime !== undefined && (mime.startsWith("text/") || mime === "application/json");
  if (textMime || (doc.fileName !== undefined && TEXT_FILE_NAMES.has(fileNameKey(doc.fileName)))) {
    return { kind: "text" };
  }
  if (mime === "application/octet-stream") {
    return { kind: "unsupported", reason: "binary" };
  }
  return { kind: "unsupported", reason: "type" };
}

/** The longest backtick run in the content, so the wrapping fence can out-top it. */
function longestBacktickRun(content: string): number {
  let longest = 0;
  for (const run of content.matchAll(/`+/g)) {
    if (run[0].length > longest) longest = run[0].length;
  }
  return longest;
}

/**
 * Wraps a text file's content into the turn's prompt: the caption (or a
 * stand-in), the 📄 header, and one fenced code block. The fence is one
 * backtick longer than any run inside the content (three minimum), and an
 * over-long file keeps its head plus a note of how much was cut — computed
 * on the full content, so a run cut short by truncation can never out-top
 * the fence either.
 */
export function buildDocumentPrompt(
  fileName: string,
  content: string,
  caption: string,
  maxChars = 24_000,
): { prompt: string; truncated: boolean } {
  const truncated = content.length > maxChars;
  const body = truncated
    ? `${content.slice(0, maxChars).trimEnd()}\n… (truncated, ${content.length} chars total)`
    : content;
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  const lead = caption.trim() !== "" ? caption.trim() : "Please use this file.";
  return { prompt: `${lead}\n📄 ${fileName}:\n${fence}\n${body}\n${fence}`, truncated };
}
