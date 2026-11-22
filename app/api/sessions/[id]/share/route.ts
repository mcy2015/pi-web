import { NextResponse } from "next/server";
import { isEphemeralRpcSession } from "@/lib/rpc-manager";
import { parseShareDurationBody } from "@/lib/share-request";
import { getShare, putShare, removeShare, summarizeShare } from "@/lib/share-store";
import { buildShareSnapshot, ShareSnapshotError } from "@/lib/share-snapshot";

export const runtime = "nodejs";

// Share management for one session. All three verbs sit behind the proxy's
// authentication like every other /api route; only the /share/<code> page is
// public, and it serves the frozen snapshot without any API call.

type Params = { params: Promise<{ id: string }> };

// An ephemeral session is never shared: the snapshot would freeze its
// memory-only conversation into the share store, on disk and outside the process.
function ephemeralRefusal() {
  return NextResponse.json(
    { error: "Ephemeral sessions cannot be shared", code: "ephemeral" },
    { status: 409 },
  );
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  if (isEphemeralRpcSession(id)) return ephemeralRefusal();
  try {
    const share = getShare(id);
    return NextResponse.json({ share: share ? summarizeShare(share) : null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  if (isEphemeralRpcSession(id)) return ephemeralRefusal();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseShareDurationBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const snapshot = await buildShareSnapshot(id);
    const share = await putShare(id, snapshot, undefined, { durationDays: parsed.durationDays });
    return NextResponse.json(summarizeShare(share));
  } catch (error) {
    if (error instanceof ShareSnapshotError) {
      return NextResponse.json(
        { error: error.message, code: error.code, culprits: error.culprits },
        { status: error.code === "session_not_found" ? 404 : 413 },
      );
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  if (isEphemeralRpcSession(id)) return ephemeralRefusal();
  try {
    // Deleting a share that is already gone is fine.
    const existed = await removeShare(id);
    return NextResponse.json({ ok: true, existed });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
