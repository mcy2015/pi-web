// Client-safe parsing of POST /api/sessions/[id]/share's body: the link
// duration the panel chose. Kept beside the types (no Node imports) so the
// route and any future UI test share the exact same rules.

import {
  DEFAULT_SHARE_DURATION_DAYS,
  isShareDurationDays,
  type ShareDurationDays,
} from "./share-types";

/**
 * {} / a body without durationDays → the 7-day default (old clients keep
 * working); a valid choice passes through; anything malformed reports an
 * error the route answers with 400.
 */
export function parseShareDurationBody(
  body: unknown,
): { ok: true; durationDays: ShareDurationDays } | { ok: false; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const raw = (body as { durationDays?: unknown }).durationDays;
  if (raw === undefined) return { ok: true, durationDays: DEFAULT_SHARE_DURATION_DAYS };
  if (isShareDurationDays(raw)) return { ok: true, durationDays: raw };
  return { ok: false, error: "durationDays must be 1, 7, 30 or null" };
}
