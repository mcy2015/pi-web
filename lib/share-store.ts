// Session shares (`pi-web-shares.json`) beside pi's own files in the agent
// dir, one share per session id. Like `pi-web-session-state.json`
// (lib/session-ui-state.ts) the file is never rebuilt from elsewhere: writes
// are serialized in-process, locked against other processes and replaced
// atomically, and a file that cannot be parsed is set aside, never overwritten.
// A share is a frozen snapshot, so revoking it takes effect immediately and
// later session changes never leak into an existing link.

import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { serializeByKey } from "./key-serializer";
import { readRegularFileText } from "./regular-file";
import {
  SHARE_CODE_PATTERN,
  type SharesFile,
  type ShareSummary,
  type StoredShare,
} from "./share-types";

// One share may embed base64 images, so the ceiling is generous but bounded.
const MAX_BYTES = 128 * 1024 * 1024;

// Route handlers are bundled separately and hot reload re-evaluates modules;
// globalThis keeps one queue per process.
const QUEUE_KEY: symbol = Symbol.for("pi-web:share-store-write-queue");

const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
  compromised: (error: Error) => {
    console.warn(`[pi-web] the share store lock was compromised: ${error.message}`);
  },
};

export class ShareStoreLockedError extends Error {
  constructor() {
    super("The share store is busy");
  }
}

export function getSharesPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-shares.json");
}

function emptyShares(): SharesFile {
  return { version: 1, shares: {} };
}

function isValidCode(code: unknown): code is string {
  return typeof code === "string" && SHARE_CODE_PATTERN.test(code);
}

/** Accepts a parsed document only when every share is well-formed. */
function normalizeShares(raw: unknown): SharesFile | null {
  if (!raw || typeof raw !== "object") return null;
  const sharesRaw = (raw as { shares?: unknown }).shares;
  if (!sharesRaw || typeof sharesRaw !== "object" || Array.isArray(sharesRaw)) return null;
  const shares: Record<string, StoredShare> = {};
  let count = 0;
  for (const [sessionId, share] of Object.entries(sharesRaw as Record<string, unknown>)) {
    if (count >= 1000) return null; // implausible size guard
    if (!share || typeof share !== "object") return null;
    const code = (share as { code?: unknown }).code;
    const createdAt = (share as { createdAt?: unknown }).createdAt;
    const snapshot = (share as { snapshot?: unknown }).snapshot;
    if (!isValidCode(code)) return null;
    if (typeof createdAt !== "string") return null;
    if (!snapshot || typeof snapshot !== "object") return null;
    const messages = (snapshot as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return null;
    shares[sessionId] = {
      code,
      createdAt,
      snapshot: snapshot as StoredShare["snapshot"],
    };
    count++;
  }
  return { version: 1, shares };
}

/** Sets an unparsable file aside beside itself; best effort. */
function backUpCorruptFile(path: string): void {
  const backup = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, backup);
    console.warn(`[pi-web] ${path} could not be parsed; moved it to ${backup} and started from empty shares`);
  } catch (error) {
    console.warn(
      `[pi-web] ${path} could not be parsed and could not be moved aside (${
        error instanceof Error ? error.message : String(error)
      }); starting from empty shares`,
    );
  }
}

/**
 * Reads the shares without taking the lock: an atomic replace means a reader
 * sees either the previous or the next complete file, never a partial one.
 * A missing file reads as empty; anything unparsable is set aside and reads
 * as empty so one bad byte cannot brick share management.
 */
export function readShares(path = getSharesPath()): SharesFile {
  const text = readRegularFileText(path, MAX_BYTES);
  if (text === undefined) return emptyShares();
  try {
    const normalized = normalizeShares(JSON.parse(text));
    if (normalized) return normalized;
  } catch {
    // fall through to the corrupt-file handling below
  }
  backUpCorruptFile(path);
  return emptyShares();
}

export function getShare(sessionId: string, path = getSharesPath()): StoredShare | null {
  return readShares(path).shares[sessionId] ?? null;
}

export function summarizeShare(share: StoredShare): ShareSummary {
  return { code: share.code, createdAt: share.createdAt, title: share.snapshot.title };
}

/** Finds the session a share code belongs to; the public page's lookup. */
export function findShareByCode(
  code: string,
  path = getSharesPath(),
): { sessionId: string; share: StoredShare } | null {
  if (!isValidCode(code)) return null;
  const shares = readShares(path).shares;
  for (const [sessionId, share] of Object.entries(shares)) {
    if (share.code === code) return { sessionId, share };
  }
  return null;
}

export function newShareCode(): string {
  return randomBytes(16).toString("base64url");
}

function editShares<T>(
  path: string,
  edit: (shares: SharesFile) => { result: T; changed: boolean },
): Promise<T> {
  return serializeByKey(QUEUE_KEY, path, async () => {
    mkdirSync(dirname(path), { recursive: true });
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(path, LOCK_OPTIONS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new ShareStoreLockedError();
      throw error;
    }
    try {
      const shares = readShares(path);
      const { result, changed } = edit(shares);
      if (changed) {
        writePrivateFileAtomicSync(path, JSON.stringify(shares, null, 2) + "\n");
      }
      return result;
    } finally {
      await release();
    }
  });
}

/**
 * Creates or refreshes a session's share. An existing share keeps its code —
 * the link stays valid — while its snapshot and createdAt are replaced.
 * The snapshot must already be size-checked (buildShareSnapshot).
 */
export function putShare(
  sessionId: string,
  snapshot: StoredShare["snapshot"],
  path = getSharesPath(),
): Promise<StoredShare> {
  return editShares(path, (shares) => {
    const existing = shares.shares[sessionId];
    const share: StoredShare = {
      code: existing?.code ?? newShareCode(),
      createdAt: new Date().toISOString(),
      snapshot,
    };
    shares.shares[sessionId] = share;
    return { result: share, changed: true };
  });
}

/** Revokes a session's share by removing its entry. False when there was none. */
export function removeShare(sessionId: string, path = getSharesPath()): Promise<boolean> {
  return editShares(path, (shares) => {
    const existed = shares.shares[sessionId] !== undefined;
    if (existed) delete shares.shares[sessionId];
    return { result: existed, changed: existed };
  });
}

/** Only for tests: the read ceiling shared with readRegularFileText callers. */
export function sharesMaxBytes(): number {
  return MAX_BYTES;
}
