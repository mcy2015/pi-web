// Client-safe types of the session share feature. `pi-web-shares.json`
// (lib/share-store.ts) holds one share per session id; each share carries a
// frozen snapshot (lib/share-snapshot.ts) the public /share/<code> page
// (app/share/[code]/page.tsx) renders without logging in.

import type { AgentMessage } from "./types";

/** Share codes are 16 random bytes, base64url-encoded (22 characters). */
export const SHARE_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** A share freezes the session's active branch at share time. */
export interface SharedSessionSnapshot {
  version: 1;
  /** Display title: the session name, else the first user message, else the id. */
  title: string;
  /** When the share was (re)created, not when the session started. */
  createdAt: string;
  /** The session's working directory, shown on the share page. */
  cwd: string;
  model: { provider: string; modelId: string } | null;
  messages: AgentMessage[];
  /** Parallel to messages, as in SessionContext. */
  entryIds: string[];
}

export interface StoredShare {
  code: string;
  createdAt: string;
  snapshot: SharedSessionSnapshot;
}

export interface SharesFile {
  version: 1;
  /** Keyed by session id; one active share per session. */
  shares: Record<string, StoredShare>;
}

/** The summary the share dialog shows for an existing share. */
export interface ShareSummary {
  code: string;
  createdAt: string;
  title: string;
}
