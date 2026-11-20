// The share admin page's read model (GET /api/shares): every stored share with
// its expiry state and whether the session behind it still exists. Pure over
// the injected session-id set — the lib layer never touches the real session
// directories, so tests need no mocking of the catalogue.

import { getSharesPath, isShareExpired, readShares } from "./share-store";
import { inferShareDurationDays, type ShareDurationDays } from "./share-types";

/** Most ids one revoke takes; the admin page sends bigger selections in parts. */
export const MAX_SHARE_REVOKE_IDS = 500;

export interface ShareAdminItem {
  sessionId: string;
  code: string;
  title: string;
  createdAt: string;
  expiresAt: string | null;
  /** The tier the row's select opens on: stored value first, inference for old files. */
  durationDays: ShareDurationDays;
  expired: boolean;
  /** The session file is gone (the judgement input is injected by the caller). */
  orphan: boolean;
}

/**
 * existingSessionIds: the set of live session ids, collected by the route from
 * the same merged catalogue a delete uses. Newest share first.
 */
export function listSharesForAdmin(
  existingSessionIds: ReadonlySet<string>,
  path = getSharesPath(),
): ShareAdminItem[] {
  return Object.entries(readShares(path).shares)
    .map(([sessionId, share]) => ({
      sessionId,
      code: share.code,
      title: share.snapshot.title,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt ?? null,
      durationDays: inferShareDurationDays(share),
      expired: isShareExpired(share),
      orphan: !existingSessionIds.has(sessionId),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
