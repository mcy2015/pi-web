import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  MAX_BRIEFINGS_PER_CHAT,
  MAX_BRIEFINGS_TOTAL,
  MAX_BRIEFING_TEXT_CHARS,
  appendBriefing,
  briefingByMessageId,
  capBriefingText,
  formatBriefings,
  parseBriefings,
  takeTurnContext,
} = await jiti.import("./briefings.ts");

function briefing(overrides = {}) {
  return {
    at: 1_000,
    automationId: "a1",
    name: "晚间简报 · 11-08 20:03",
    status: "done",
    replyText: " briefing body ".repeat(10).trim(),
    sessionFile: "/sessions/run.jsonl",
    messageIds: [11],
    deliveredAt: null,
    ...overrides,
  };
}

test("parseBriefings keeps well-formed entries and drops the rest", () => {
  const parsed = parseBriefings({
    "5722077379": [briefing(), briefing({ at: 2_000, messageIds: [12, 13], deliveredAt: 1_500 })],
    "not-a-key": [briefing()],
    "42": [briefing({ status: "running" }), briefing({ messageIds: "11" }), briefing({ at: "x" }), "nope", null],
    "43": [briefing({ sessionFile: 5 })],
    "44": [],
    broken: "nope",
  });
  assert.deepEqual(Object.keys(parsed), ["5722077379"]);
  assert.equal(parsed["5722077379"].length, 2);
  assert.equal(parsed["5722077379"][1].messageIds.length, 2);
});

test("parseBriefings of a non-object is empty", () => {
  assert.deepEqual(parseBriefings(null), {});
  assert.deepEqual(parseBriefings("x"), {});
  assert.deepEqual(parseBriefings([briefing()]), {});
});

test("capBriefingText truncates long text with the marker, keeps short text", () => {
  const short = "all fine";
  assert.equal(capBriefingText(short), short);
  const long = "x".repeat(MAX_BRIEFING_TEXT_CHARS + 500);
  const capped = capBriefingText(long);
  assert.ok(capped.length <= MAX_BRIEFING_TEXT_CHARS);
  assert.ok(capped.includes("[truncated"));
});

test("appendBriefing keeps the newest per chat and the newest globally", () => {
  let state = { briefings: {} };
  for (let index = 0; index < MAX_BRIEFINGS_PER_CHAT + 2; index++) {
    state = appendBriefing(state, 1, briefing({ at: index, messageIds: [index] }));
  }
  assert.equal(state.briefings["1"].length, MAX_BRIEFINGS_PER_CHAT);
  // The two oldest were evicted; the newest is last.
  assert.equal(state.briefings["1"][0].at, 2);
  assert.equal(state.briefings["1"][state.briefings["1"].length - 1].at, MAX_BRIEFINGS_PER_CHAT + 1);
  // Filling more chats than the global cap allows evicts the globally oldest
  // entries — chat 1's head — once the total crosses the cap.
  const chats = Math.ceil((MAX_BRIEFINGS_TOTAL + 4) / MAX_BRIEFINGS_PER_CHAT);
  for (let chat = 2; chat <= chats; chat++) {
    for (let index = 0; index < MAX_BRIEFINGS_PER_CHAT; index++) {
      state = appendBriefing(state, chat, briefing({ at: 100_000 + chat * 100 + index, messageIds: [1_000 + chat * 100 + index] }));
    }
  }
  const total = Object.values(state.briefings).reduce((count, list) => count + list.length, 0);
  assert.equal(total, MAX_BRIEFINGS_TOTAL);
  // The globally oldest — chat 1's whole tail — is what got evicted.
  assert.equal(state.briefings["1"], undefined);
});

test("briefingByMessageId matches any delivered chunk id", () => {
  const list = [briefing({ messageIds: [21] }), briefing({ messageIds: [31, 32, 33] })];
  assert.equal(briefingByMessageId(list, 21), list[0]);
  assert.equal(briefingByMessageId(list, 33), list[1]);
  assert.equal(briefingByMessageId(list, 99), undefined);
});

test("takeTurnContext with nothing to quote changes nothing", () => {
  const state = { briefings: { "1": [briefing({ deliveredAt: 900 })] } };
  const taken = takeTurnContext(state, 1, undefined, 2_000);
  assert.equal(taken.state, state);
  assert.equal(taken.context, "");
});

test("takeTurnContext quotes and stamps undelivered briefings once", () => {
  const state = {
    briefings: {
      "1": [
        briefing({ at: 1_000, name: "早安 · 11-08 07:30", messageIds: [11] }),
        briefing({ at: 2_000, name: "晚间 · 11-08 20:03", messageIds: [12] }),
      ],
    },
  };
  const first = takeTurnContext(state, 1, undefined, 3_000);
  assert.notEqual(first.context, "");
  assert.ok(first.context.includes("早安"));
  assert.ok(first.context.includes("晚间"));
  assert.ok(first.context.includes("/sessions/run.jsonl"));
  assert.ok(first.state.briefings["1"].every((entry) => entry.deliveredAt === 3_000));
  // The next message has nothing new to see.
  const second = takeTurnContext(first.state, 1, undefined, 4_000);
  assert.equal(second.state, first.state);
  assert.equal(second.context, "");
});

test("takeTurnContext quotes a replied-to briefing, even one already delivered", () => {
  const delivered = briefing({ at: 1_000, name: "晚间 · 11-08 20:03", messageIds: [12], deliveredAt: 1_500 });
  const fresh = briefing({ at: 2_000, name: "早安 · 11-09 07:30", messageIds: [13] });
  const state = { briefings: { "1": [delivered, fresh] } };
  const taken = takeTurnContext(state, 1, 12, 3_000);
  assert.ok(taken.context.includes("replies to this briefing"));
  // The already-delivered one is quoted again without a state change beyond
  // stamping the fresh one.
  assert.equal(taken.state.briefings["1"][0].deliveredAt, 1_500);
  assert.equal(taken.state.briefings["1"][1].deliveredAt, 3_000);
  // Replying to an unknown message id quotes only the undelivered.
  const unknown = takeTurnContext(state, 1, 9_999, 3_000);
  assert.ok(unknown.context.includes("早安"));
  assert.ok(!unknown.context.includes("replies to this briefing"));
});

test("replying to only an already-delivered briefing changes no state", () => {
  const state = { briefings: { "1": [briefing({ deliveredAt: 900 })] } };
  const taken = takeTurnContext(state, 1, 11, 2_000);
  assert.equal(taken.state, state);
  assert.ok(taken.context.includes("replies to this briefing"));
});

test("an over-budget context keeps the newest full and degrades the oldest", () => {
  const big = "x".repeat(4_000);
  const entries = [
    briefing({ at: 1_000, name: "old one", replyText: big, messageIds: [11] }),
    briefing({ at: 2_000, name: "middle one", replyText: big, messageIds: [12] }),
    briefing({ at: 3_000, name: "newest one", replyText: big, messageIds: [13] }),
  ];
  const state = { briefings: { "1": entries } };
  const taken = takeTurnContext(state, 1, undefined, 4_000);
  assert.ok(taken.context.includes("newest one"));
  assert.ok(taken.context.includes("middle one"));
  assert.ok(taken.context.includes("old one"));
  assert.ok(taken.context.includes("full text omitted for space"));
  // The degraded entry is the oldest, and it still names its run session.
  const degradedAt = taken.context.indexOf("full text omitted");
  assert.ok(taken.context.indexOf("old one") < degradedAt);
  assert.ok(taken.context.includes("Run session file: /sessions/run.jsonl"));
});

test("formatBriefings marks the single replied-to entry", () => {
  const one = briefing({ name: "晚间 · 11-08 20:03" });
  const context = formatBriefings([one], one);
  assert.ok(context.includes("Automation briefing the user replied to"));
  assert.ok(context.includes("replies to this briefing"));
});
