import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { notifyRetryDelayMs, briefingFromOutcome } = await jiti.import("./notify.ts");
const { TelegramApiError } = await jiti.import("../telegram/bot-api.ts");
const { MAX_BRIEFING_TEXT_CHARS } = await jiti.import("../telegram/briefings.ts");

const networkError = () => new TelegramApiError("Telegram sendMessage failed: fetch failed", null, null);

test("network-level failures back off 15s/30s/60s then stop", () => {
  assert.equal(notifyRetryDelayMs(0, networkError()), 15_000);
  assert.equal(notifyRetryDelayMs(1, networkError()), 30_000);
  assert.equal(notifyRetryDelayMs(2, networkError()), 60_000);
  assert.equal(notifyRetryDelayMs(3, networkError()), null);
});

test("server-side API answers retry too", () => {
  assert.equal(notifyRetryDelayMs(0, new TelegramApiError("x", "Too Many Requests", 429)), 15_000);
  assert.equal(notifyRetryDelayMs(1, new TelegramApiError("x", "Internal Server Error", 500)), 30_000);
});

test("client-side API rejections are final", () => {
  assert.equal(notifyRetryDelayMs(0, new TelegramApiError("x", "Bad Request: message text is empty", 400)), null);
  assert.equal(notifyRetryDelayMs(0, new TelegramApiError("x", "Forbidden: bot was blocked by the user", 403)), null);
});

test("unexpected error shapes still retry, bounded", () => {
  assert.equal(notifyRetryDelayMs(0, new TypeError("fetch failed")), 15_000);
  assert.equal(notifyRetryDelayMs(3, new TypeError("fetch failed")), null);
});

test("briefingFromOutcome records the pushed text capped, not yet delivered", () => {
  const automation = { id: "auto-1", name: "晚间简报", notifyChannels: [] };
  const outcome = {
    status: "done",
    name: "晚间简报 · 11-08 20:03",
    reply: "body",
    error: null,
    sessionFile: "/sessions/run.jsonl",
    startedAt: 1,
    durationMs: 2,
  };
  const briefing = briefingFromOutcome(automation, outcome, "✅ header\n\nbody", [41, 42], 1_234);
  assert.deepEqual(briefing, {
    at: 1_234,
    automationId: "auto-1",
    name: "晚间简报 · 11-08 20:03",
    status: "done",
    replyText: "✅ header\n\nbody",
    sessionFile: "/sessions/run.jsonl",
    messageIds: [41, 42],
    deliveredAt: null,
  });
  const long = briefingFromOutcome(
    automation,
    outcome,
    "x".repeat(MAX_BRIEFING_TEXT_CHARS + 100),
    [43],
    1_234,
  );
  assert.ok(long.replyText.length <= MAX_BRIEFING_TEXT_CHARS);
  assert.ok(long.replyText.includes("[truncated"));
});
