import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  jsx: { runtime: "automatic" },
  moduleCache: false,
});
const { trendPoints, trendLabelIndexes, heatLevel, buildHeatmapWeeks, heatmapBars, heatmapMonthGroups } = await jiti.import("./usage-charts.tsx");


test("trendPoints maps values into the padded viewBox", () => {
  assert.deepEqual(trendPoints([], 720, 150), []);

  // Two points: start and end at the horizontal padding.
  const two = trendPoints([0, 100], 720, 150, 8);
  assert.equal(two.length, 2);
  assert.equal(two[0].x, 8);
  assert.equal(two[1].x, 712);
  assert.equal(two[0].y, 142); // zero sits on the baseline
  assert.equal(two[1].y, 8); // the max touches the top

  // All-zero data maps to a flat line (max floor of 1).
  const flat = trendPoints([0, 0], 720, 150, 8);
  assert.equal(flat[0].y, flat[1].y);

  // A single point sits at the left padding.
  const one = trendPoints([5], 720, 150, 8);
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


test("buildHeatmapWeeks anchors 52 weeks ending at the latest day with usage", () => {
  const days = [];
  const base = new Date(2026, 9, 4); // 2026-11-04 local, a Wednesday
  const key = (d) => {
    const pad = (v) => (v < 10 ? `0${v}` : String(v));
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  for (let back = 10; back >= 0; back--) {
    const d = new Date(base);
    d.setDate(d.getDate() - back);
    days.push({ date: key(d), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: back % 2 ? 100 : 0, cost: 0, messages: back % 2 ? 3 : 0 });
  }
  const weeks = buildHeatmapWeeks(days);
  assert.equal(weeks.length, 78);
  for (const week of weeks) assert.equal(week.length, 7);
  // The last week holds the latest day WITH USAGE (base - 1 here: base has none).
  const dayBeforeBase = new Date(base);
  dayBeforeBase.setDate(dayBeforeBase.getDate() - 1);
  const lastWeek = weeks[weeks.length - 1];
  assert.ok(lastWeek.some((day) => day.date === key(dayBeforeBase)), "latest day with usage anchors the last week");
  // The window starts on a Sunday.
  const firstDay = new Date(weeks[0][0].date + "T00:00:00");
  assert.equal(firstDay.getDay(), 0);
  // Days outside the data are empty cells, not holes.
  assert.equal(weeks[0][0].total, 0);
  assert.equal(weeks[0][0].messages, 0);
  // No data at all -> no weeks.
  assert.deepEqual(buildHeatmapWeeks([{ date: "2026-01-01", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, messages: 0 }]), []);
});

test("heatmapBars aggregates weekly sums and cumulative running totals", () => {
  const weekOf = (total) => Array.from({ length: 7 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, total: i === 0 ? total : 0, messages: i === 0 && total > 0 ? 2 : 0 }));
  const weeks = [weekOf(10), weekOf(0), weekOf(30)];
  const weekly = heatmapBars(weeks, "weekly");
  assert.deepEqual(weekly.values, [10, 0, 30]);
  assert.deepEqual(weekly.messages, [2, 0, 2]);
  assert.deepEqual(weekly.barCells, [Math.ceil(10 / 30 * 7), 0, 7]);

  const cumulative = heatmapBars(weeks, "cumulative");
  assert.deepEqual(cumulative.values, [10, 10, 40]);
  assert.deepEqual(cumulative.messages, [2, 2, 4]);
  assert.deepEqual(cumulative.barCells, [Math.ceil(10 / 40 * 7), Math.ceil(10 / 40 * 7), 7]);
});

test("heatmapMonthGroups merges same-month columns and caps at 12 labels", () => {
  const weekOf = (startKey) => {
    const [y, m, d] = startKey.split("-").map(Number);
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(y, m - 1, d + i);
      const pad = (v) => (v < 10 ? `0${v}` : String(v));
      const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      return { date: key, total: 0, messages: 0 };
    });
  };
  // Four weeks inside January: one group, span 4.
  const weeks = [weekOf("2026-01-04"), weekOf("2026-01-11"), weekOf("2026-01-18"), weekOf("2026-01-25")];
  const labels = heatmapMonthGroups(weeks, () => "Jan");
  assert.equal(labels.length, 1);
  assert.equal(labels[0].span, 4);

  // A week containing the 1st names that month (lXn: the -01 day wins).
  const withFirst = [weekOf("2026-01-29"), weekOf("2026-02-05")];
  const mixed = heatmapMonthGroups(withFirst, (key) => (key.startsWith("2026-02") ? "Feb" : "Jan"));
  // First week holds 2026-02-01, so it is February despite starting in January.
  assert.equal(mixed[0].label, "Feb");

  // Every month in the window keeps its label (no ZCode 12-label cap here).
  const many = [];
  for (let m = 0; m < 14; m++) {
    const date = new Date(2025, m, 5);
    const pad = (v) => (v < 10 ? `0${v}` : String(v));
    many.push(weekOf(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-05`));
  }
  const labelled = heatmapMonthGroups(many, (key) => key.slice(0, 7));
  assert.equal(labelled.length, 14);
  for (const group of labelled) assert.notEqual(group.label, "");
});
