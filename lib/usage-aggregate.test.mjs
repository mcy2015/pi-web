import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { foldSessionLines, mergeUsageSnapshot, localDayKey } = await jiti.import("../lib/usage-aggregate.ts");
const { computeSessionStats } = await jiti.import("../lib/session-stats.ts");
const { computeSessionTotalActiveMs } = await jiti.import("../lib/session-timing.ts");
const { sideOwnEntries } = await jiti.import("../lib/side-session.ts");

// A fixed moment in a fixed timezone-agnostic base; day keys are computed in
// the server's local timezone, so tests derive expected keys from localDayKey
// instead of hardcoding dates.
const START = Date.parse("2026-10-05T01:00:00.000Z");

function at(offsetMs) {
  return new Date(START + offsetMs).toISOString();
}

const MIN = 60_000;
const HOUR = 60 * MIN;

function usage(input, output, { cacheRead = 0, cacheWrite = 0, cost = 0 } = {}) {
  return { input, output, cacheRead, cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}

function userEntry(id, ts, extra = {}) {
  return { type: "message", id, parentId: null, timestamp: ts, message: { role: "user", content: "go", ...extra } };
}

function assistantEntry(id, ts, { usage: u, model = "test/model-a", content = [] } = {}) {
  // A real assistant message stores provider and the bare modelId.
  const [provider, ...rest] = model.split("/");
  return {
    type: "message", id, parentId: null, timestamp: ts,
    message: {
      role: "assistant", content, model: rest.join("/"), provider, ...(u ? { usage: u } : {}),
    },
  };
}

function toolResultEntry(id, ts, u, toolName = "read") {
  return {
    type: "message", id, parentId: null, timestamp: ts,
    message: { role: "toolResult", toolCallId: `call-${id}`, toolName, content: [{ type: "text", text: "ok" }], usage: u },
  };
}

function toolCallBlock(id, name) {
  return { type: "toolCall", toolCallId: `call-${id}`, toolName: name, input: {} };
}

function header(overrides = {}) {
  return { type: "session", version: 3, id: "s-test", timestamp: at(0), cwd: "/work/alpha", ...overrides };
}

function fold(headerJson, entries) {
  return foldSessionLines(headerJson, entries.map((entry) => JSON.stringify(entry)));
}

function sumDays(folded) {
  const totals = { activeMs: 0 };
  for (const day of folded.days.values()) totals.activeMs += day.activeMs;
  return totals;
}

test("fold totals equal computeSessionStats over the same (timestamp-filtered) entries", () => {
  const headerJson = header();
  const entries = [
    { type: "model_change", id: "mc1", parentId: null, timestamp: at(1), provider: "test", modelId: "model-a" },
    userEntry("u1", at(2 * MIN)),
    assistantEntry("a1", at(3 * MIN), { usage: usage(1000, 200, { cost: 0.02 }) }),
    assistantEntry("a2", at(4 * MIN), { usage: undefined, content: [toolCallBlock("t1", "read"), toolCallBlock("t2", "bash")] }),
    toolResultEntry("r1", at(5 * MIN), usage(500, 50, { cacheRead: 700, cost: 0.01 })),
    { type: "compaction", id: "c1", parentId: null, timestamp: at(6 * MIN), summary: "s", firstKeptEntryId: "x", tokensBefore: 10, usage: usage(30, 0) },
    { type: "usage", id: "us1", parentId: null, timestamp: at(7 * MIN), kind: "cache_warm", provider: "test", model: "model-a", usage: usage(10, 0) },
    { type: "branch_summary", id: "bs1", parentId: null, timestamp: at(8 * MIN), fromId: "x", summary: "s", usage: usage(5, 0) },
    { type: "session_info", id: "si1", parentId: null, timestamp: at(9 * MIN), name: "renamed" },
  ];
  const folded = fold(headerJson, entries);
  assert.ok(folded);

  const expected = computeSessionStats(entries);
  let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0, messages = 0, toolCalls = 0;
  for (const day of folded.days.values()) {
    tokens.input += day.input; tokens.output += day.output;
    tokens.cacheRead += day.cacheRead; tokens.cacheWrite += day.cacheWrite;
    cost += day.cost; messages += day.messages; toolCalls += day.toolCalls;
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  assert.equal(tokens.input, expected.tokens.input);
  assert.equal(tokens.output, expected.tokens.output);
  assert.equal(tokens.cacheRead, expected.tokens.cacheRead);
  assert.equal(tokens.cacheWrite, expected.tokens.cacheWrite);
  assert.equal(tokens.total, expected.tokens.total);
  assert.equal(cost, expected.cost);
  assert.equal(messages, expected.totalMessages);
  assert.equal(toolCalls, expected.toolCalls);
});

test("fold counts tools with both toolName and legacy name fields", () => {
  const entries = [
    assistantEntry("a1", at(MIN), {
      content: [
        { type: "toolCall", toolCallId: "c1", toolName: "read", input: {} },
        { type: "toolCall", toolCallId: "c2", name: "bash", arguments: {} },
      ],
    }),
  ];
  const folded = fold(header(), entries);
  const tools = new Map();
  for (const day of folded.days.values()) for (const [name, count] of day.tools) tools.set(name, (tools.get(name) ?? 0) + count);
  assert.equal(tools.get("read"), 1);
  assert.equal(tools.get("bash"), 1);
});

test("per-day activeMs sums to computeSessionTotalActiveMs, with user gaps as idle", () => {
  const entries = [
    userEntry("u1", at(0)),
    assistantEntry("a1", at(2 * MIN)),
    userEntry("u2", at(30 * MIN)), // 28min human idle, not counted
    assistantEntry("a2", at(31 * MIN)),
    { type: "bashExecution-message" , id: "x", parentId: null, timestamp: at(40 * MIN), message: { role: "bashExecution", command: "ls", output: "" } },
    assistantEntry("a3", at(41 * MIN)),
  ];
  const folded = fold(header(), entries);
  assert.equal(sumDays(folded).activeMs, computeSessionTotalActiveMs(entries));
});

test("entries at or before the header timestamp are skipped (fork/side inherited prefix)", () => {
  // A fork: header is new, copied entries keep old timestamps.
  const inherited = [
    userEntry("old-u1", at(0)),
    assistantEntry("old-a1", at(MIN), { usage: usage(100, 10) }),
  ];
  const own = [
    userEntry("new-u1", at(HOUR)),
    assistantEntry("new-a1", at(HOUR + MIN), { usage: usage(20, 5) }),
  ];
  const forkHeader = header({ id: "s-fork", timestamp: at(30 * MIN) });
  const folded = fold(forkHeader, [...inherited, ...own]);
  let input = 0;
  for (const day of folded.days.values()) input += day.input;
  assert.equal(input, 20);

  // Same-second first entry survives (>= cut): a session whose header and
  // first entry share a millisecond still counts that entry.
  const sameTs = at(0);
  const kept = fold(header({ timestamp: sameTs }), [userEntry("u0", sameTs), assistantEntry("a0", at(MIN), { usage: usage(7, 3) })]);
  let keptInput = 0;
  for (const day of kept.days.values()) keptInput += day.input;
  assert.equal(keptInput, 7);
});

test("fold matches sideOwnEntries for a side chat's own entries", () => {
  // A side chat's header is its copy moment; inherited entries keep older
  // timestamps (before the header), its own entries come after both the header
  // and the side metadata's createdAt.
  const sideMeta = { type: "custom", id: "meta1", parentId: null, timestamp: at(2 * MIN), customType: "pi-web:side", data: { version: 1, parentSessionId: "s-parent", createdAt: at(10 * MIN) } };
  const inherited = [assistantEntry("old-a", at(1 * MIN), { usage: usage(100, 10) })];
  const own = [assistantEntry("own-a", at(20 * MIN), { usage: usage(40, 4) })];
  const all = [...inherited, sideMeta, ...own];

  const expected = sideOwnEntries(all);
  assert.equal(expected.includes(inherited[0]), false);
  assert.equal(expected.includes(own[0]), true);

  const folded = fold(header({ id: "s-side", timestamp: at(3 * MIN) }), all);
  let input = 0;
  for (const day of folded.days.values()) input += day.input;
  assert.equal(input, 40);
});

test("model attribution follows model_change, entry overrides, and falls back", () => {
  const entries = [
    { type: "model_change", id: "mc1", parentId: null, timestamp: at(MIN), provider: "p1", modelId: "m1" },
    assistantEntry("a1", at(2 * MIN), { usage: usage(10, 1), model: "p1/m1" }), // assistant's own fields
    { type: "model_change", id: "mc2", parentId: null, timestamp: at(3 * MIN), provider: "p2", modelId: "m2" },
    assistantEntry("a2", at(4 * MIN), { usage: usage(20, 2), model: "p2/m2" }),
    toolResultEntry("r1", at(5 * MIN), usage(30, 3)), // no model of its own -> current cursor p2/m2
    { type: "usage", id: "us1", parentId: null, timestamp: at(6 * MIN), kind: "cache_warm", provider: "p3", model: "m3", usage: usage(40, 4) }, // entry's own
  ];
  const folded = fold(header(), entries);
  const models = new Map();
  for (const day of folded.days.values()) for (const [model, u] of day.models) {
    const row = models.get(model) ?? { input: 0 };
    row.input += u.input;
    models.set(model, row);
  }
  assert.equal(models.get("p1/m1").input, 10);
  assert.equal(models.get("p2/m2").input, 50); // a2 + r1
  assert.equal(models.get("p3/m3").input, 40);
});

test("entries before the first model_change attribute to it anyway", () => {
  // assistantEntry always sets provider/model; emulate an old file manually:
  const oldStyle = [
    { type: "message", id: "a0", parentId: null, timestamp: at(MIN), message: { role: "assistant", content: [], usage: usage(10, 1) } },
    { type: "model_change", id: "mc1", parentId: null, timestamp: at(2 * MIN), provider: "px", modelId: "mx" },
  ];
  const folded = fold(header(), oldStyle);
  const models = [...folded.days.values()].flatMap((day) => [...day.models.keys()]);
  assert.deepEqual(models, ["px/mx"]);
});

test("malformed lines and unusable headers are tolerated", () => {
  const lines = [
    JSON.stringify(userEntry("u1", at(MIN))),
    "{torn json", // torn tail line
    JSON.stringify(assistantEntry("a1", at(2 * MIN), { usage: usage(10, 1) })),
    JSON.stringify({ type: "message", id: "nts", parentId: null, message: { role: "user", content: "x" } }), // no timestamp
  ];
  const folded = foldSessionLines(header(), lines);
  assert.ok(folded);
  let messages = 0;
  for (const day of folded.days.values()) messages += day.messages;
  assert.equal(messages, 2);

  assert.equal(foldSessionLines({ type: "message" }, []), null);
  assert.equal(foldSessionLines(null, []), null);
});

test("subagent header flag reflects parentSession", () => {
  const folded = fold(header({ parentSession: "/other.jsonl" }), []);
  assert.equal(folded.isSubagent, true);
  const plain = fold(header(), []);
  assert.equal(plain.isSubagent, false);
});

// ---------------------------------------------------------------------------
// mergeUsageSnapshot
// ---------------------------------------------------------------------------

function fileWithDays(sessionId, cwd, dayMap) {
  const days = new Map();
  for (const [key, bucket] of Object.entries(dayMap)) {
    const day = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, messages: 0, toolCalls: 0, activeMs: 0,
      hours: new Array(24).fill(0), models: new Map(), tools: new Map(),
      ...bucket,
    };
    days.set(key, day);
  }
  return { sessionId, cwd, days };
}

test("merge computes overview, streaks, cache hit rate, peak hour, daily zero-fill", () => {
  const now = new Date(2026, 9, 5, 15, 0, 0); // local 2026-10-05 15:00
  const today = localDayKey(now.getTime());
  const yesterday = localDayKey(now.getTime() - 24 * HOUR * 1.001);
  const twoDaysAgo = localDayKey(now.getTime() - 48 * HOUR * 1.001);

  const files = [
    fileWithDays("s1", "/work/alpha", {
      [twoDaysAgo]: { input: 100, cacheRead: 900, total: 1100, messages: 4, activeMs: MIN, hours: (() => { const h = new Array(24).fill(0); h[14] = 500; h[15] = 600; return h; })() },
      [today]: { input: 200, cacheRead: 800, total: 1100, messages: 6, activeMs: 2 * MIN },
    }),
    fileWithDays("s2", "/work/beta", {
      [yesterday]: { input: 50, cacheRead: 0, total: 50, messages: 2, activeMs: 0 },
    }),
  ];

  const all = mergeUsageSnapshot(files, "all", { files: 2, skipped: 0 }, now);
  assert.equal(all.range.days, null);
  assert.equal(all.overview.tokens.input, 350);
  assert.equal(all.overview.tokens.cacheRead, 1700);
  assert.equal(all.overview.messages, 12);
  assert.equal(all.overview.sessions, 2);
  assert.equal(all.overview.activeDays, 3);
  assert.equal(all.overview.totalActiveMs, 3 * MIN);
  // streak: today, yesterday and two days ago are all active
  assert.equal(all.activity.currentStreakDays, 3);
  assert.equal(all.activity.longestStreakDays, 3);
  assert.equal(all.overview.topModel, null); // no per-model data in these buckets
  assert.ok(Math.abs(all.activity.cacheHitRate - 1700 / 2050) < 1e-9);
  assert.equal(all.activity.peakHour, 15);
  // daily zero-fills from first active day through today
  assert.equal(all.daily.length, 3);
  assert.equal(all.daily[1].date, yesterday);
  assert.equal(all.daily[1].total, 50);
  assert.equal(all.daily[0].messages, 4);
  // projects sorted by total
  assert.equal(all.projects[0].cwd, "/work/alpha");
  assert.equal(all.projects[0].sessions, 1);

  const week = mergeUsageSnapshot(files, 7, { files: 2, skipped: 0 }, now);
  assert.equal(week.range.days, 7);
  assert.equal(week.overview.messages, 12);
});

test("merge range cut drops older days and empty snapshot answers nulls", () => {
  const now = new Date(2026, 9, 5, 15, 0, 0);
  const oldDay = localDayKey(now.getTime() - 40 * 24 * HOUR);
  const today = localDayKey(now.getTime());
  const files = [
    fileWithDays("s1", "/w", {
      [oldDay]: { input: 999, total: 999, messages: 5 },
      [today]: { input: 10, total: 10, messages: 1 },
    }),
  ];
  const week = mergeUsageSnapshot(files, 7, { files: 1, skipped: 0 }, now);
  assert.equal(week.overview.messages, 1);
  assert.equal(week.overview.tokens.input, 10);
  // The window still starts at the cutoff, zero-filling headless days.
  const cutoff = localDayKey(new Date(2026, 9, 5, 15, 0, 0).getTime() - 6 * 24 * HOUR * 1.001);
  assert.equal(week.range.from, cutoff);
  assert.equal(week.daily.length, 7);

  const empty = mergeUsageSnapshot([], "all", { files: 0, skipped: 0 }, now);
  assert.equal(empty.overview.messages, 0);
  assert.equal(empty.overview.topModel, null);
  assert.equal(empty.activity.cacheHitRate, null);
  assert.equal(empty.activity.peakHour, null);
  assert.equal(empty.activity.currentStreakDays, 0);
  assert.equal(empty.activity.longestStreakDays, 0);
  assert.equal(empty.range.from, null);
  assert.deepEqual(empty.daily.map((d) => d.date), [today]);
});

test("streaks cross consecutive calendar days and reset on gaps", () => {
  const now = new Date(2026, 9, 10, 9, 0, 0);
  const d = (back) => localDayKey(now.getTime() - back * 24 * HOUR * 1.001);
  const files = [
    fileWithDays("s1", "/w", {
      [d(1)]: { input: 1, total: 1, messages: 1 },
      [d(2)]: { input: 1, total: 1, messages: 1 },
      [d(3)]: { input: 1, total: 1, messages: 1 },
      [d(6)]: { input: 1, total: 1, messages: 1 },
      [d(7)]: { input: 1, total: 1, messages: 1 },
    }),
  ];
  const snap = mergeUsageSnapshot(files, "all", { files: 1, skipped: 0 }, now);
  // today (d0) has no activity -> current counts from yesterday: 3 days
  assert.equal(snap.activity.currentStreakDays, 3);
  assert.equal(snap.activity.longestStreakDays, 3);
});
