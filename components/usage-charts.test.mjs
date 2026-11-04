import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  jsx: { runtime: "automatic" },
  moduleCache: false,
});
const { trendPoints, trendLabelIndexes, heatLevel, barPercent } = await jiti.import("./usage-charts.tsx");

function day(date, total) {
  return { date, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total, cost: 0, messages: 0 };
}

test("trendPoints maps days into the padded viewBox", () => {
  assert.deepEqual(trendPoints([], 720, 150), []);

  // Two points: start and end at the horizontal padding.
  const two = trendPoints([day("2026-01-01", 0), day("2026-01-02", 100)], 720, 150, 8);
  assert.equal(two.length, 2);
  assert.equal(two[0].x, 8);
  assert.equal(two[1].x, 712);
  assert.equal(two[0].y, 142); // zero total sits on the baseline
  assert.equal(two[1].y, 8); // the max touches the top

  // All-zero data maps to a flat line on the baseline (max floor of 1).
  const flat = trendPoints([day("2026-01-01", 0), day("2026-01-02", 0)], 720, 150, 8);
  assert.equal(flat[0].y, flat[1].y);

  // A single point sits at the left padding.
  const one = trendPoints([day("2026-01-01", 5)], 720, 150, 8);
  assert.equal(one.length, 1);
  assert.equal(one[0].x, 8);
});

test("trendLabelIndexes always includes first and last, spread between", () => {
  assert.deepEqual(trendLabelIndexes(0), []);
  assert.deepEqual(trendLabelIndexes(3), [0, 1, 2]);
  const many = trendLabelIndexes(90);
  assert.equal(many[0], 0);
  assert.equal(many[many.length - 1], 89);
  assert.ok(many.length <= 5);
  for (let i = 1; i < many.length; i++) assert.ok(many[i] > many[i - 1]);
});

test("heatLevel buckets ratios into 0..4", () => {
  assert.equal(heatLevel(0, 100), 0);
  assert.equal(heatLevel(5, 0), 0); // no max -> nothing to shade
  assert.equal(heatLevel(10, 100), 1);
  assert.equal(heatLevel(25, 100), 1);
  assert.equal(heatLevel(26, 100), 2);
  assert.equal(heatLevel(50, 100), 2);
  assert.equal(heatLevel(51, 100), 3);
  assert.equal(heatLevel(75, 100), 3);
  assert.equal(heatLevel(76, 100), 4);
  assert.equal(heatLevel(100, 100), 4);
});

test("barPercent keeps a minimum visible sliver", () => {
  assert.equal(barPercent(0, 100), 0);
  assert.equal(barPercent(50, 100), 50);
  assert.equal(barPercent(100, 100), 100);
  assert.equal(barPercent(1, 1000), 2);
  assert.equal(barPercent(5, 0), 0);
});
