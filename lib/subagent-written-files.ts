import type { AgentMessage, ToolResultMessage } from "./types";
import { isSubagentToolDetails } from "./subagent-tool-details";
import { extractTurnWrittenFiles, type WrittenFile } from "./turn-written-files";

/** A subagent tool call whose files should join the parent turn's list. */
export interface SubagentSource {
  sessionId: string;
  /** The child's cwd when known: a worktree checkout, else the parent's. */
  cwd?: string;
}

interface SessionContextPage {
  messages: AgentMessage[];
  entryIds: string[];
  oldestEntryId: string | null;
  hasMore: boolean;
}

/**
 * The settled subagent sessions a turn's messages carry: each `subagent` tool
 * call whose result details name a pi-web subagent that is no longer starting,
 * queued or running. Files of a live subagent would be a partial list, so the
 * parent waits for it to settle (the turn ends with it).
 */
export function collectSubagentSources(
  messages: readonly AgentMessage[],
  toolResults: ReadonlyMap<string, ToolResultMessage>,
): SubagentSource[] {
  const sources: SubagentSource[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content ?? []) {
      if (block.type !== "toolCall") continue;
      const result = toolResults.get(block.toolCallId);
      const details = isSubagentToolDetails(result?.details) ? result?.details : null;
      if (!details) continue;
      if (details.status === "starting" || details.status === "queued" || details.status === "running") continue;
      if (seen.has(details.sessionId)) continue;
      seen.add(details.sessionId);
      sources.push({ sessionId: details.sessionId, cwd: details.worktreePath });
    }
  }
  return sources;
}

/** The written files of a session's messages, over a results map the fetcher builds. */
export function extractSessionWrittenFiles(
  messages: readonly AgentMessage[],
  toolResults: ReadonlyMap<string, ToolResultMessage>,
  cwd?: string,
): WrittenFile[] {
  const content = messages.flatMap((message) =>
    message.role === "assistant" ? (message.content ?? []) : [],
  );
  return extractTurnWrittenFiles(content, toolResults as Map<string, ToolResultMessage>, cwd);
}

/** Page a session's context from its newest entry backwards, up to `maxPages`. */
async function fetchSessionTranscript(sessionId: string, maxPages: number): Promise<{ messages: readonly AgentMessage[]; cwd: string | null }> {
  const messages: AgentMessage[] = [];
  let cwd: string | null = null;
  let before: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ tail: "1000", deferThinking: "", deferMedia: "" });
    if (before) params.set("before", before);
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context?${params}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`context ${res.status}`);
    const data = await res.json() as { context: Partial<SessionContextPage>; cwd?: string | null };
    cwd ??= data.cwd ?? null;
    const context = data.context ?? {};
    const pageMessages = Array.isArray(context.messages) ? context.messages : [];
    messages.unshift(...pageMessages);
    if (!context.hasMore || !context.oldestEntryId) return { messages, cwd };
    before = context.oldestEntryId;
  }
  return { messages, cwd };
}

interface CacheEntry {
  files: WrittenFile[];
}

/** Settled subagent transcripts never change, so their files cache for good. */
const settledFiles = new Map<string, Promise<CacheEntry | null>>();
/** A failed fetch caches briefly: a reload or a later turn may retry it. */
const failedAt = new Map<string, number>();
const FAILED_RETRY_MS = 30_000;

/**
 * The files one settled subagent session wrote, resolved against its own cwd
 * (a worktree path when it ran in one, else the fallback cwd given). Cached
 * per session id; null means the transcript could not be read.
 */
export function fetchSubagentWrittenFiles(
  sessionId: string,
  worktreePath: string | undefined,
  fallbackCwd: string | undefined,
): Promise<CacheEntry | null> {
  const cached = settledFiles.get(sessionId);
  if (cached) return cached;
  const failed = failedAt.get(sessionId);
  if (failed !== undefined && Date.now() - failed < FAILED_RETRY_MS) {
    return Promise.resolve(null);
  }

  const load = (async (): Promise<CacheEntry | null> => {
    try {
      const { messages, cwd: sessionCwd } = await fetchSessionTranscript(sessionId, 5);
      const toolResults = new Map<string, ToolResultMessage>();
      for (const message of messages) {
        if (message.role === "toolResult") toolResults.set((message as ToolResultMessage).toolCallId, message as ToolResultMessage);
      }
      const cwd = worktreePath ?? sessionCwd ?? fallbackCwd;
      return { files: extractSessionWrittenFiles(messages, toolResults, cwd) };
    } catch {
      failedAt.set(sessionId, Date.now());
      return null;
    }
  })();

  settledFiles.set(sessionId, load);
  // A rejection would poison the cache for the page's life; failures resolve null.
  load.catch(() => failedAt.set(sessionId, Date.now()));
  return load;
}

/** Forget a session's cached files (tests). */
export function clearSubagentWrittenFilesCache(): void {
  settledFiles.clear();
  failedAt.clear();
}
