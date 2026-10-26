import { NextResponse } from "next/server";
import { getShare, putShare, removeShare, summarizeShare } from "@/lib/share-store";
import { buildShareSnapshot, ShareSnapshotError } from "@/lib/share-snapshot";

export const runtime = "nodejs";

// Share management for one session. All three verbs sit behind the proxy's
// authentication like every other /api route; only the /share/<code> page is
// public, and it serves the frozen snapshot without any API call.

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const share = getShare(id);
    return NextResponse.json({ share: share ? summarizeShare(share) : null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const snapshot = await buildShareSnapshot(id);
    const share = await putShare(id, snapshot);
    return NextResponse.json(summarizeShare(share));
  } catch (error) {
    if (error instanceof ShareSnapshotError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.code === "session_not_found" ? 404 : 413 },
      );
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    // Deleting a share that is already gone is fine.
    const existed = await removeShare(id);
    return NextResponse.json({ ok: true, existed });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
