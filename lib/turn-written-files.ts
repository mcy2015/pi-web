import type { AssistantContentBlock, ToolResultMessage } from "./types";
import { resolveLocalFilePath } from "./file-links";
import { isApplyPatchToolName, isBashToolName, isEditToolName, isWriteToolName } from "./tool-names";
import { extractBashWrittenPaths } from "./bash-written-files";
import { CODEMODE_TOOL_NAME, codemodeCalls } from "./codemode-view";
import {
  applyPatchPreviewToFiles,
  applyPatchResultHasFailures,
  getApplyPatchAppliedFiles,
  getApplyPatchInputText,
  parseApplyPatchInput,
} from "./apply-patch";
import type { SplitDiffFile } from "./patch";

export interface WrittenFile {
  /** Resolved absolute path of a file this turn wrote. */
  filePath: string;
}

function isFileWritingToolName(toolName: string): boolean {
  return isWriteToolName(toolName) || isEditToolName(toolName);
}

function readToolPath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const value = input.file_path ?? input.path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A shell tool's command text, whichever key it arrived under. */
function readBashCommand(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const value = input.command ?? input.cmd ?? input.script;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Unescape the JSON string escapes a regex had to leave in place. */
function unescapeJsonishString(value: string): string {
  return value.replace(/\\(.)/g, (_, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "t") return "\t";
    if (escaped === "r") return "\r";
    return escaped;
  });
}

/**
 * The path a codemode script's nested `write`/`edit` call touched. The SDK
 * records each nested call's arguments as compact JSON, truncated for long
 * payloads — when the JSON no longer parses, the leading `"path":` key is
 * read directly; when even that was cut away the call is unknowable.
 */
function readNestedCallPath(args: string): string | null {
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return readToolPath(parsed as Record<string, unknown>);
    }
    return null;
  } catch {
    const match = args.match(/"(?:file_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return match ? unescapeJsonishString(match[1]) : null;
  }
}

function writtenPathsFromFiles(files: SplitDiffFile[] | null): string[] {
  if (!files) return [];
  // Deletes have no newPath — they are not files this turn wrote.
  return files
    .map((file) => file.newPath)
    .filter((filePath): filePath is string => typeof filePath === "string" && filePath.length > 0);
}

function collectApplyPatchDeletePaths(input: Record<string, unknown> | undefined, details: unknown): Set<string> {
  const deleted = new Set<string>();
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const preview = (details as Record<string, unknown>).preview;
    if (preview && typeof preview === "object" && !Array.isArray(preview)) {
      const files = (preview as Record<string, unknown>).files;
      if (Array.isArray(files)) {
        for (const raw of files) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const entry = raw as { operation?: unknown; filePath?: unknown };
          if (entry.operation === "delete" && typeof entry.filePath === "string" && entry.filePath.length > 0) {
            deleted.add(entry.filePath);
          }
        }
      }
    }
  }
  for (const match of getApplyPatchInputText(input).matchAll(/^\*\*\* Delete File: (.+)$/gm)) {
    const filePath = (match[1] ?? "").trim();
    if (filePath) deleted.add(filePath);
  }
  return deleted;
}

/**
 * Collect the paths one apply_patch call actually wrote.
 *
 * Prefers `details.result.appliedFiles` (what landed, including rename
 * targets). Falls back to the applied-result preview, then the patch
 * document. Deletes are omitted — they are not files this turn wrote.
 * A returned failure with no `appliedFiles` writes nothing.
 */
function readApplyPatchPaths(input: Record<string, unknown> | undefined, result: ToolResultMessage | undefined): string[] {
  const details = result?.details;
  const deleted = collectApplyPatchDeletePaths(input, details);
  const applied = getApplyPatchAppliedFiles(details);
  if (applied) return applied.filter((filePath) => !deleted.has(filePath));
  if (applyPatchResultHasFailures(details)) return [];

  if (details && typeof details === "object" && !Array.isArray(details)) {
    const fromPreview = writtenPathsFromFiles(applyPatchPreviewToFiles((details as Record<string, unknown>).preview));
    if (fromPreview.length > 0) return fromPreview;
  }
  return writtenPathsFromFiles(parseApplyPatchInput(getApplyPatchInputText(input)));
}

/**
 * Collect the paths a codemode script actually wrote, from the nested call
 * log its result carries (`details.calls`). Those calls never reach the model
 * as tool calls of their own, so this is the only record of them. Calls the
 * SDK left out (`omittedCalls`) are unknowable and go unlisted.
 */
function readCodemodeWrittenPaths(result: ToolResultMessage | undefined): string[] {
  const { calls } = codemodeCalls(result?.details);
  const paths: string[] = [];
  for (const call of calls) {
    if (call.status !== "ok") continue;
    if (!isWriteToolName(call.name) && !isEditToolName(call.name)) continue;
    const path = readNestedCallPath(call.args);
    if (path) paths.push(path);
  }
  return paths;
}

/**
 * Collect the distinct files a single assistant turn actually wrote.
 *
 * Every entry is derived from a `write`/`edit`/`apply_patch` tool call whose
 * result arrived and did not error — never from the reply text. A path the
 * assistant merely mentions in prose is not evidence that any file was
 * touched, so it is not a source here; the tool call is the record of what
 * happened. Two weaker records join them, both still result-gated: the
 * nested `write`/`edit` calls of a `codemode` script, and the paths a
 * `bash` command writes (redirects, `sed -i`, `mv`, … — parsed, so a guess).
 *
 * Paths are resolved against `cwd`, deduped, and kept in first-seen order.
 */
export function extractTurnWrittenFiles(
  content: AssistantContentBlock[],
  toolResults: Map<string, ToolResultMessage> | undefined,
  cwd?: string,
): WrittenFile[] {
  const seen = new Set<string>();
  const writtenFiles: WrittenFile[] = [];

  const addPath = (rawPath: string) => {
    // Tool arguments are filesystem paths, not hrefs: preserve characters such
    // as #, ?, and :digits that have special meaning in links and source refs.
    const filePath = resolveLocalFilePath(rawPath, cwd);
    if (!filePath) return;

    if (seen.has(filePath)) return;
    seen.add(filePath);
    writtenFiles.push({ filePath });
  };

  for (const block of content) {
    if (block.type !== "toolCall") continue;
    if (!isFileWritingToolName(block.toolName) && !isApplyPatchToolName(block.toolName)
      && !isBashToolName(block.toolName) && block.toolName !== CODEMODE_TOOL_NAME) continue;

    const result = toolResults?.get(block.toolCallId);
    if (!result || result.isError) continue;

    let rawPaths: (string | null | undefined)[];
    if (isApplyPatchToolName(block.toolName)) {
      rawPaths = readApplyPatchPaths(block.input, result);
    } else if (isBashToolName(block.toolName)) {
      const command = readBashCommand(block.input);
      rawPaths = command ? extractBashWrittenPaths(command) : [];
    } else if (block.toolName === CODEMODE_TOOL_NAME) {
      rawPaths = readCodemodeWrittenPaths(result);
    } else {
      rawPaths = [readToolPath(block.input)];
    }

    for (const rawPath of rawPaths) {
      if (rawPath) addPath(rawPath);
    }
  }

  return writtenFiles;
}
