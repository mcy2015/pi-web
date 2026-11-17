import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { parseShareDurationBody } = await jiti.import("./share-request.ts");

test("an empty or duration-less body picks the 7-day default", () => {
  assert.deepEqual(parseShareDurationBody({}), { ok: true, durationDays: 7 });
  assert.deepEqual(parseShareDurationBody({ unrelated: true }), { ok: true, durationDays: 7 });
});

test("a legal duration passes through, null meaning permanent", () => {
  for (const durationDays of [1, 7, 30, null]) {
    assert.deepEqual(parseShareDurationBody({ durationDays }), { ok: true, durationDays });
  }
});

test("off-choice values are rejected with the route's error text", () => {
  for (const durationDays of [0, 8, -7, "7", true, {}]) {
    assert.deepEqual(parseShareDurationBody({ durationDays }), {
      ok: false,
      error: "durationDays must be 1, 7, 30 or null",
    });
  }
});

test("a parsable but non-object body is rejected", () => {
  for (const body of [[], [7], "x", 7, true, null]) {
    assert.deepEqual(parseShareDurationBody(body), { ok: false, error: "Body must be a JSON object" });
  }
});
