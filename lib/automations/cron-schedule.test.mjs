import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseCronExpr, nextDueTime, scheduleProblem } = await jiti.import("./cron-schedule.ts");

const T = (s) => Date.parse(s);

test("parseCronExpr: five fields, lists, ranges, steps", () => {
  assert.ok(parseCronExpr("* * * * *"));
  assert.ok(parseCronExpr("0 8 * * *"));
  assert.ok(parseCronExpr("*/15 0,6,12,18 * * 1-5"));
  assert.ok(parseCronExpr("5-10/2 8 1 1 0"));
  assert.equal(parseCronExpr("0 8 * *"), null);
  assert.equal(parseCronExpr("60 8 * * *"), null);
  assert.equal(parseCronExpr("0 8 * * 7"), null);
  assert.equal(parseCronExpr("0 8 0 * *"), null);
  assert.equal(parseCronExpr("a 8 * * *"), null);
  assert.equal(parseCronExpr("5-2 8 * * *"), null);
});

test("at: only the future fires", () => {
  assert.equal(nextDueTime({ kind: "at", atMs: T("2026-11-01T08:00:00Z") }, T("2026-10-26T00:00:00Z")), T("2026-11-01T08:00:00Z"));
  assert.equal(nextDueTime({ kind: "at", atMs: T("2026-11-01T08:00:00Z") }, T("2026-11-02T00:00:00Z")), null);
});

test("every: the next multiple strictly after from", () => {
  assert.equal(nextDueTime({ kind: "every", everyMs: 3_600_000 }, T("2026-10-26T10:17:00Z")), T("2026-10-26T11:00:00Z"));
  assert.equal(nextDueTime({ kind: "every", everyMs: 3_600_000 }, T("2026-10-26T11:00:00Z")), T("2026-10-26T12:00:00Z"));
});

test("cron: daily at 8 in a timezone", () => {
  // UTC reading.
  assert.equal(nextDueTime({ kind: "cron", expr: "0 8 * * *", tz: "UTC" }, T("2026-10-26T07:59:00Z")), T("2026-10-26T08:00:00Z"));
  assert.equal(nextDueTime({ kind: "cron", expr: "0 8 * * *", tz: "UTC" }, T("2026-10-26T08:00:00Z")), T("2026-10-27T08:00:00Z"));
  // Shanghai is UTC+8: 08:00 wall is 00:00 UTC.
  assert.equal(nextDueTime({ kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" }, T("2026-10-25T23:59:00Z")), T("2026-10-26T00:00:00Z"));
  assert.equal(nextDueTime({ kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" }, T("2026-10-26T00:00:00Z")), T("2026-10-27T00:00:00Z"));
});

test("cron: weekdays, steps and the day OR rule", () => {
  // Weekdays at 9 UTC.
  assert.equal(nextDueTime({ kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" }, T("2026-10-24T00:00:00Z")), T("2026-10-26T09:00:00Z")); // Sat -> Mon
  // Every 15 minutes.
  assert.equal(nextDueTime({ kind: "cron", expr: "*/15 * * * *", tz: "UTC" }, T("2026-10-26T10:07:00Z")), T("2026-10-26T10:15:00Z"));
  // The 1st or any Monday: 2026-11-01 is a Sunday, 2026-11-02 a Monday.
  assert.equal(nextDueTime({ kind: "cron", expr: "0 0 1 * 1", tz: "UTC" }, T("2026-10-26T00:00:00Z")), T("2026-11-01T00:00:00Z"));
  // Only when one day field is restricted does it have to match: day 1 AND dow 1.
  // After Nov 1 (a Sunday), the next "1st or Monday" is Nov 2, a Monday.
  assert.equal(nextDueTime({ kind: "cron", expr: "0 0 1 * 1", tz: "UTC" }, T("2026-11-01T12:00:00Z")), T("2026-11-02T00:00:00Z"));
});

test("cron: month boundaries and impossible days", () => {
  // End of month: Oct 31 23:59 -> Nov 1 00:00 for "0 0 1 * *".
  assert.equal(nextDueTime({ kind: "cron", expr: "0 0 1 * *", tz: "UTC" }, T("2026-10-31T23:59:00Z")), T("2026-11-01T00:00:00Z"));
  // February 30th never happens.
  assert.equal(nextDueTime({ kind: "cron", expr: "0 0 30 2 *", tz: "UTC" }, T("2026-10-26T00:00:00Z")), null);
});

test("cron: DST shifts resolve to the clock the zone has", () => {
  // America/New_York springs forward on 2026-03-08: 02:00 -> 03:00.
  // 02:30 does not exist that day; 03:30 does.
  assert.equal(nextDueTime({ kind: "cron", expr: "30 3 8 3 *", tz: "America/New_York" }, T("2026-01-01T00:00:00Z")), T("2026-03-08T07:30:00Z"));
});

test("scheduleProblem", () => {
  assert.equal(scheduleProblem({ kind: "at", atMs: 123 }), null);
  assert.equal(scheduleProblem({ kind: "every", everyMs: 30_000 }), "everyMs must be at least one minute");
  assert.equal(scheduleProblem({ kind: "every", everyMs: 3_600_000 }), null);
  assert.equal(scheduleProblem({ kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" }), null);
  assert.equal(scheduleProblem({ kind: "cron", expr: "0 8 * * *", tz: "Mars/Olympus" }), "unknown timezone");
  assert.equal(scheduleProblem({ kind: "cron", expr: "nope", tz: "UTC" }), "not a five-field cron expression");
});
