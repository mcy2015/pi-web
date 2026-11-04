import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getUsageSnapshot } from "@/lib/usage-aggregate";
import { isUsageRangeDays } from "@/lib/usage-types";

export const dynamic = "force-dynamic";

// Settings › Usage: the aggregated local session history. A GET (no body), so
// only the request-origin check applies. Reading never starts an AgentSession.

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }

  const params = new URL(req.url).searchParams;
  const rawRange = params.get("range") ?? "all";
  const range = rawRange === "7" ? 7 : rawRange === "30" ? 30 : rawRange === "90" ? 90 : rawRange === "all" ? "all" : undefined;
  if (range === undefined || !isUsageRangeDays(range)) {
    return NextResponse.json({ error: "range must be 7, 30, 90 or all" }, { status: 400, headers: NO_STORE });
  }
  const force = params.get("force") === "1";

  try {
    const snapshot = await getUsageSnapshot({ range, force });
    return NextResponse.json(snapshot, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Failed to aggregate usage" }, { status: 500, headers: NO_STORE });
  }
}
