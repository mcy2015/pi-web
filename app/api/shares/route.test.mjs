import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST, MAX_SHARE_REVOKE_IDS } = await jiti.import("./route.ts");
const { invalidateSessionListCache } = await jiti.import("../../../lib/session-reader.ts");

// The rejection paths never reach the store, so they run against plain
// Requests; the happy paths redirect the agent dir (getAgentDir reads
// PI_CODING_AGENT_DIR per call) into a scratch directory, the same trick
// app/api/sessions/delete-route.test.mjs uses.

const JSON_HEADERS = { host: "localhost", "Content-Type": "application/json" };
const TIME = "2026-10-01T00:00:00.000Z";

function post(body, headers = JSON_HEADERS) {
  return POST(new Request("http://localhost/api/shares", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

function get(headers = { host: "localhost" }) {
  return GET(new Request("http://localhost/api/shares", { headers }));
}

function scratchAgentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-shares-route-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateSessionListCache();
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    invalidateSessionListCache();
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, "sessions", "--work-alpha--"), { recursive: true });
  return dir;
}

/** A session file as pi writes it, so the catalogue scan sees a live session. */
function writeSessionFile(sessionsDir, { id, name }) {
  const lines = [
    { type: "session", version: 3, id, timestamp: TIME, cwd: "/work/alpha" },
    { type: "message", id: `${id}-u`, parentId: null, timestamp: TIME, message: { role: "user", content: `hello ${name}`, timestamp: Date.parse(TIME) } },
    { type: "message", id: `${id}-a`, parentId: `${id}-u`, timestamp: TIME, message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.parse(TIME) } },
  ];
  writeFileSync(join(sessionsDir, `${name}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function writeShares(agentDir, shares) {
  writeFileSync(join(agentDir, "pi-web-shares.json"), `${JSON.stringify({ version: 1, shares }, null, 2)}\n`, { mode: 0o600 });
}

test("a shares request must be trusted, JSON-shaped and well-formed", async () => {
  assert.equal((await post({ action: "revoke", ids: ["a"] }, { host: "localhost", "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post({ action: "revoke", ids: ["a"] }, { host: "evil.example", "Content-Type": "application/json" })).status, 403);
  assert.equal((await get({ host: "evil.example" })).status, 403);
  for (const body of [
    "{",
    [],
    {},
    { ids: ["a"] },
    { action: "nope" },
    { action: "revoke", ids: "a" },
    { action: "revoke", ids: [] },
    { action: "revoke", ids: ["../a"] },
    { action: "revoke", ids: [1] },
    { action: "revoke", ids: Array.from({ length: MAX_SHARE_REVOKE_IDS + 1 }, (_, index) => `s${index}`) },
    { action: "renew" },
    { action: "renew", sessionId: "../a", durationDays: 7 },
    { action: "renew", sessionId: "a", durationDays: 8 },
    { action: "renew", sessionId: "a", durationDays: "7" },
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(typeof (await response.json()).error, "string");
  }
});

test("GET lists every share with expiry and orphan flags, newest first", async (t) => {
  const dir = scratchAgentDir(t);
  writeSessionFile(join(dir, "sessions", "--work-alpha--"), { id: "live-1", name: "live" });
  writeShares(dir, {
    "live-1": {
      code: "abcdefghijklmnopqrstuv",
      createdAt: "2026-02-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      snapshot: { messages: [], title: "Live" },
    },
    "gone-1": {
      code: "bcdefghijklmnopqrstuvw",
      createdAt: "2026-02-03T00:00:00.000Z",
      expiresAt: "2026-02-04T00:00:00.000Z", // already past
      snapshot: { messages: [], title: "Gone" },
    },
  });

  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const { shares } = await response.json();
  assert.deepEqual(shares.map((share) => share.sessionId), ["gone-1", "live-1"]); // createdAt desc
  const byId = Object.fromEntries(shares.map((share) => [share.sessionId, share]));
  assert.equal(byId["live-1"].orphan, false);
  assert.equal(byId["live-1"].expired, false);
  assert.equal(byId["live-1"].expiresAt, "2099-01-01T00:00:00.000Z");
  assert.equal(byId["gone-1"].orphan, true); // its session file never existed
  assert.equal(byId["gone-1"].expired, true);
  assert.equal(byId["gone-1"].title, "Gone");
  assert.equal(byId["gone-1"].code, "bcdefghijklmnopqrstuvw");
});

test("renew moves the expiry without re-freezing; a session without a share 404s", async (t) => {
  const dir = scratchAgentDir(t);
  writeShares(dir, {
    "sid-1": {
      code: "abcdefghijklmnopqrstuv",
      createdAt: "2026-02-01T00:00:00.000Z",
      expiresAt: "2026-02-02T00:00:00.000Z", // long expired
      durationDays: 1,
      snapshot: { messages: [], title: "Frozen" },
    },
  });

  const missing = await post({ action: "renew", sessionId: "nobody", durationDays: 7 });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "No share for that session");

  const before = Date.now();
  const response = await post({ action: "renew", sessionId: "sid-1", durationDays: 30 });
  const after = Date.now();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const { share } = await response.json();
  assert.equal(share.code, "abcdefghijklmnopqrstuv");
  assert.equal(share.createdAt, "2026-02-01T00:00:00.000Z"); // the freeze moment stays
  assert.equal(share.title, "Frozen");
  assert.equal(share.durationDays, 30); // the tier the UI's select should open on
  const expiresAt = Date.parse(share.expiresAt);
  assert.ok(expiresAt > before + 29 * 86_400_000 && expiresAt < after + 31 * 86_400_000, share.expiresAt);

  const permanent = await post({ action: "renew", sessionId: "sid-1", durationDays: null });
  assert.equal(permanent.status, 200);
  assert.equal((await permanent.json()).share.expiresAt, null);
});

test("revoke removes the listed shares in one pass, skipping ids without one", async (t) => {
  const dir = scratchAgentDir(t);
  writeShares(dir, {
    "sid-1": { code: "abcdefghijklmnopqrstuv", createdAt: "2026-02-01T00:00:00.000Z", snapshot: { messages: [], title: "One" } },
    "sid-2": { code: "bcdefghijklmnopqrstuvw", createdAt: "2026-02-02T00:00:00.000Z", snapshot: { messages: [], title: "Two" } },
    "sid-3": { code: "cdefghijklmnopqrstuvwx", createdAt: "2026-02-03T00:00:00.000Z", snapshot: { messages: [], title: "Three" } },
  });

  const response = await post({ action: "revoke", ids: ["sid-1", "sid-2", "sid-2", "nope"] });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, revoked: ["sid-1", "sid-2"] });

  const list = await (await get()).json();
  assert.deepEqual(list.shares.map((share) => share.sessionId), ["sid-3"]);
});
