// Projects a session into the frozen snapshot a share link serves. The
// snapshot is self-contained: the active branch at share time with thinking
// and images inline (base64), so the public page never calls back into the
// authenticated /api/files for media. Too-large sessions are refused up front
// instead of writing a share the page cannot serve comfortably.

import { getRpcSession } from "./rpc-manager";
import {
  buildSessionContext,
  openSessionManager,
  resolveSessionPath,
} from "./session-reader";
import type { SharedSessionSnapshot } from "./share-types";
import type { AgentMessage, SessionEntry } from "./types";

export const MAX_SHARE_SNAPSHOT_BYTES = 25 * 1024 * 1024;

export class ShareSnapshotError extends Error {
  readonly code: "session_not_found" | "too_large";

  constructor(code: ShareSnapshotError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export function firstUserText(messages: AgentMessage[]): string {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content.find((block) => block.type === "text") as { text?: string } | undefined;
      if (text?.text) return text.text;
    }
  }
  return "";
}

export function snapshotTitle(
  sessionName: string | undefined,
  messages: AgentMessage[],
  sessionId: string,
): string {
  if (sessionName) return sessionName;
  const first = firstUserText(messages).trim();
  if (first) return first.length > 80 ? `${first.slice(0, 80)}…` : first;
  return sessionId;
}

/**
 * Builds the share snapshot of a session's active branch. A running session is
 * read from its in-memory manager, a finished one from disk. Throws
 * ShareSnapshotError with code "session_not_found" or "too_large".
 */
export async function buildShareSnapshot(sessionId: string): Promise<SharedSessionSnapshot> {
  const rpc = getRpcSession(sessionId);
  const liveRpc = rpc?.isAlive() ? rpc : undefined;
  const filePath = liveRpc ? null : await resolveSessionPath(sessionId);
  if (!liveRpc && !filePath) {
    throw new ShareSnapshotError("session_not_found", "Session not found");
  }

  const sm = liveRpc?.inner.sessionManager ?? openSessionManager(filePath!);
  const entries = sm.getEntries() as unknown as SessionEntry[];
  // No tail, no deferred thinking, no lazy media URLs (no sessionId): the
  // whole branch, self-contained.
  const context = buildSessionContext(entries as never, sm.getLeafId(), {});

  const snapshot: SharedSessionSnapshot = {
    version: 1,
    title: snapshotTitle(sm.getSessionName(), context.messages, sessionId),
    createdAt: new Date().toISOString(),
    cwd: sm.getHeader()?.cwd ?? "",
    model: context.model,
    messages: context.messages,
    entryIds: context.entryIds,
  };

  // Measure the serialized form: that is what the share page downloads.
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  if (bytes > MAX_SHARE_SNAPSHOT_BYTES) {
    throw new ShareSnapshotError(
      "too_large",
      `The session snapshot is ${Math.round(bytes / (1024 * 1024))} MB; the limit is ${
        MAX_SHARE_SNAPSHOT_BYTES / (1024 * 1024)
      } MB`,
    );
  }

  return snapshot;
}
