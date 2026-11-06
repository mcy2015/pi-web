import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readAutoNameSessionsEnabled, writeAutoNameSessionsEnabled } from "@/lib/web-settings-file";

export const dynamic = "force-dynamic";

// Settings › General's switch for naming a session automatically once its first
// answer completes (`lib/auto-session-title.ts` fires it server-side, so it
// covers the web UI, Channels and Automations alike). On is the default, so
// turning it on removes the key from `pi-web-settings.json` and off writes
// `false` — never a key pi-web's own reads would have to keep in step.

function errorResponse(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

export async function GET() {
  try {
    return NextResponse.json({ enabled: await readAutoNameSessionsEnabled() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  try {
    return NextResponse.json({ enabled: await writeAutoNameSessionsEnabled(enabled) });
  } catch (error) {
    return errorResponse(error);
  }
}
