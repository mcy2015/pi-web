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

/** The durations a share link can live for; null = permanent. */
export const SHARE_DURATION_CHOICES = [1, 7, 30] as const;
export type ShareDurationDays = (typeof SHARE_DURATION_CHOICES)[number] | null;
export const DEFAULT_SHARE_DURATION_DAYS = 7;

export function isShareDurationDays(value: unknown): value is ShareDurationDays {
  return value === null
    || (typeof value === "number" && (SHARE_DURATION_CHOICES as readonly number[]).includes(value));
}

/**
 * The duration a share's UI should show: the stored value when present (always
 * written by put/renew); for old files without it, derived from
 * expiresAt − createdAt — but ONLY when the difference lands exactly on a
 * choice (renew breaks that invariant: expiresAt moves, createdAt does not).
 * Anything else falls back to the 7-day default. null expiresAt = permanent.
 */
export function inferShareDurationDays(share: {
  durationDays?: ShareDurationDays;
  expiresAt?: string | null;
  createdAt: string;
}): ShareDurationDays {
  if (share.durationDays !== undefined) return share.durationDays;
  if (share.expiresAt == null) return null;
  const ms = Date.parse(share.expiresAt) - Date.parse(share.createdAt);
  if (!Number.isFinite(ms)) return DEFAULT_SHARE_DURATION_DAYS;
  const days = Math.round(ms / 86_400_000);
  const choices = SHARE_DURATION_CHOICES as readonly number[];
  return choices.includes(days) ? (days as (typeof SHARE_DURATION_CHOICES)[number]) : DEFAULT_SHARE_DURATION_DAYS;
}

export interface StoredShare {
  code: string;
  createdAt: string;
  /** ISO UTC. null or missing = permanent (older files predate the field). */
  expiresAt?: string | null;
  /** The duration last chosen (put or renew). Missing = old file; infer via inferShareDurationDays. */
  durationDays?: ShareDurationDays;
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
  expiresAt: string | null;
  /** The tier the UI should show: the stored choice, or the inference for old files. */
  durationDays: ShareDurationDays;
  title: string;
}
