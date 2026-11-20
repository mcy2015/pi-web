import { NextResponse } from "next/server";
import { getRpcSessionInfos } from "@/lib/rpc-manager";
import { listSharesForAdmin } from "@/lib/share-admin";
import { parseShareDurationBody } from "@/lib/share-request";
import { renewShare, removeShares, summarizeShare } from "@/lib/share-store";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { listAllSessions, mergeSessionLists } from "@/lib/session-reader";
import { SESSION_ID_PATTERN } from "@/lib/session-ui-state-shared";
import { MAX_SHARE_REVOKE_IDS } from "@/lib/share-admin";

export const dynamic = "force-dynamic";

// The share admin page's backend. GET lists every stored share with its expiry
// state — the session-id set behind the orphan flags comes from the same merged
// catalogue a delete uses, one scan however many shares there are. POST is the
// page's action endpoint in the channels-route style: revoke (many ids in one
// locked pass) and renew (move expiresAt without re-freezing the session).

/** Most ids one revoke takes; the admin page sends bigger selections in parts. */
const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

// GET /api/shares - the admin page's list.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "Untrusted API request");
  try {
    const sessions = mergeSessionLists(
      await listAllSessions({ force: true }),
      getRpcSessionInfos({ includeTransient: true }),
    ).filter((session) => !session.ephemeral);
    const existingIds = new Set(sessions.map((session) => session.id));
    return NextResponse.json({ shares: listSharesForAdmin(existingIds) }, { headers: NO_STORE });
  } catch (error) {
    return refusal(500, error instanceof Error ? error.message : String(error));
  }
}

// POST /api/shares - body { action: "revoke", ids } or { action: "renew", sessionId, durationDays }.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "Content-Type must be application/json");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "Invalid JSON body");
  }
  const fields = typeof body === "object" && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  const action = fields?.action;

  if (action === "revoke") {
    const ids = fields?.ids;
    if (!Array.isArray(ids) || ids.length === 0) return refusal(400, "ids must be a non-empty array");
    if (!ids.every((id) => typeof id === "string" && SESSION_ID_PATTERN.test(id))) return refusal(400, "ids must be session ids");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length > MAX_SHARE_REVOKE_IDS) return refusal(400, `ids may hold at most ${MAX_SHARE_REVOKE_IDS} session ids`);
    try {
      // An id without a share is silently skipped: revoking what a concurrent
      // request already took away is not an error, same as the single DELETE.
      const revoked = await removeShares(uniqueIds);
      return NextResponse.json({ ok: true, revoked }, { headers: NO_STORE });
    } catch (error) {
      return refusal(500, error instanceof Error ? error.message : String(error));
    }
  }

  if (action === "renew") {
    const sessionId = fields?.sessionId;
    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return refusal(400, "sessionId must be a session id");
    const parsed = parseShareDurationBody(body);
    if (!parsed.ok) return refusal(400, parsed.error);
    try {
      const share = await renewShare(sessionId, parsed.durationDays);
      if (!share) return refusal(404, "No share for that session");
      return NextResponse.json({ share: summarizeShare(share) }, { headers: NO_STORE });
    } catch (error) {
      return refusal(500, error instanceof Error ? error.message : String(error));
    }
  }

  return refusal(400, "action must be revoke or renew");
}
