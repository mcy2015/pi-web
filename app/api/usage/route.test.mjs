import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: usageRoute } = await jiti.import("./route.ts");
const { invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import("../../../lib/session-reader.ts");
const { invalidateUsageFileCache } = await jiti.import("../../../lib/usage-aggregate.ts");

const START = Date.parse("2026-10-05T01:00:00.000Z");

function get(path) {
  return usageRoute(new Request(`http://localhost${path}`, { headers: { host: "localhost" } }));
}

function at(offsetMs) {
  return new Date(START + offsetMs).toISOString();
}

function usage(input, output, cost) {
  return { input, output, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}

async function writeSession(sessionsDir, id, lines) {
  const path = join(sessionsDir, `${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: at(0), cwd: "/work/usage-test" };
  await writeFile(path, `${[header, ...lines].map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

function sessionLines({ input = 100, output = 10, cost = 0.01, tool = "read", model = { provider: "p", modelId: "m" } } = {}) {
  return [
    { type: "model_change", id: "mc1", parentId: null, timestamp: at(1000), provider: model.provider, modelId: model.modelId },
    { type: "message", id: "u1", parentId: null, timestamp: at(2000), message: { role: "user", content: "go" } },
    {
      type: "message", id: "a1", parentId: "u1", timestamp: at(3000),
      message: {
        role: "assistant", content: [{ type: "toolCall", toolCallId: "c1", toolName: tool, input: {} }],
        model: model.modelId, provider: model.provider, usage: usage(input, output, cost),
      },
    },
  ];
}

async function scratchAgentDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-usage-route-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__piSessions = new Map();
  invalidateSessionListCache();
  invalidateUsageFileCache();
  const ids = [];
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (const id of ids) invalidateSessionPathCache(id);
    invalidateSessionListCache();
    invalidateUsageFileCache();
    await rm(dir, { recursive: true, force: true });
  });
  const sessionsDir = join(dir, "sessions", "--work-usage-test--");
  await mkdir(sessionsDir, { recursive: true });
  return { sessionsDir, ids };
}

test("aggregates the scratch history into a snapshot", async (t) => {
  const { sessionsDir, ids } = await scratchAgentDir(t);
  ids.push("usage-a", "usage-b");
  await writeSession(sessionsDir, "usage-a", sessionLines({ input: 1000, output: 200, cost: 0.02 }));
  await writeSession(sessionsDir, "usage-b", sessionLines({ input: 300, output: 50, cost: 0.004, model: { provider: "q", modelId: "n" } }));

  const res = await get("/api/usage?range=all");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.overview.tokens.input, 1300);
  assert.equal(body.overview.tokens.output, 250);
  assert.equal(body.overview.cost, 0.024);
  assert.equal(body.overview.messages, 4); // 2 per session
  assert.equal(body.overview.sessions, 2);
  assert.equal(body.overview.topModel.model, "p/m");
  assert.equal(body.tools[0].name, "read");
  assert.equal(body.tools[0].count, 2);
  assert.equal(body.models.length, 2);
  assert.equal(body.projects[0].cwd, "/work/usage-test");
  assert.ok(Array.isArray(body.daily) && body.daily.length >= 1);
});

test("range is validated and defaults to all", async (t) => {
  await scratchAgentDir(t);
  const bad = await get("/api/usage?range=13");
  assert.equal(bad.status, 400);
  const ok = await get("/api/usage");
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).range.days, null);
});

test("an empty history answers an empty, well-formed snapshot", async (t) => {
  await scratchAgentDir(t);
  const res = await get("/api/usage?range=30");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.overview.messages, 0);
  assert.equal(body.overview.topModel, null);
  assert.equal(body.activity.cacheHitRate, null);
  assert.equal(body.meta.skipped, 0);
});

test("a file with an unusable header is ignored without failing the answer", async (t) => {
  const { sessionsDir } = await scratchAgentDir(t);
  await writeFile(join(sessionsDir, "usage-broken.jsonl"), "not json at all\n{more garbage}\n");

  const res = await get("/api/usage");
  assert.equal(res.status, 200);
  const body = await res.json();
  // The session-list scan never lists a file whose header it cannot read, so
  // the aggregator only ever sees foldable files; skipped stays 0 here.
  assert.equal(body.overview.messages, 0);
  assert.equal(body.meta.files, 0);
});

test("untrusted origins are refused", async () => {
  const res = await usageRoute(new Request("http://evil.example/api/usage", {
    headers: { origin: "http://evil.example" },
  }));
  assert.equal(res.status, 403);
});
