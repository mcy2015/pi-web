import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  editAutomations,
  readAutomations,
  runsOf,
  automationsPath,
  fileHasRunsInProgress,
  RUN_HISTORY_LIMIT,
} = await jiti.import("./store.ts");

const dir = mkdtempSync(join(tmpdir(), "pi-web-automations-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const path = automationsPath(dir);

const automation = {
  id: "a1",
  name: "Morning briefing",
  enabled: true,
  schedule: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
  cwd: "/work",
  prompt: "Brief me.",
  model: null,
  thinkingLevel: null,
  notify: true,
  nextDueAt: 1_000,
  lastRunAt: null,
  createdAt: 123,
};

test("empty file reads as empty; edits round-trip and keep unknown fields", async () => {
  assert.deepEqual(readAutomations(path), { automations: [], runs: [] });
  await editAutomations(() => ({
    file: { automations: [automation], runs: [] },
    changed: true,
  }), path);
  const read = readAutomations(path);
  assert.equal(read.automations.length, 1);
  assert.deepEqual(read.automations[0], automation);
  // A newer build's field survives an edit.
  const { readFileSync } = await import("node:fs");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.futureField = { keep: true };
  writeFileSync(path, JSON.stringify(raw));
  await editAutomations((current) => ({
    file: { ...current, runs: [{ id: "r1", automationId: "a1", trigger: "schedule", startedAt: 5, finishedAt: 6, status: "done", sessionId: "s", sessionFile: "f", error: null }] },
    changed: true,
  }), path);
  const raw2 = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(raw2.futureField, { keep: true });
  assert.equal(raw2.runs.length, 1);
});

test("malformed automations and runs are dropped, not fatal", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.automations = [automation, { id: "bad" }, "nope", null];
  raw.runs = [raw.runs[0], { id: "x" }];
  writeFileSync(path, JSON.stringify(raw));
  const read = readAutomations(path);
  assert.equal(read.automations.length, 1);
  assert.equal(read.runs.length, 1);
});

test("a corrupt file is set aside; the next edit starts fresh", async () => {
  writeFileSync(path, "{not json");
  assert.deepEqual(readAutomations(path), { automations: [], runs: [] });
  await editAutomations(() => ({
    file: { automations: [], runs: [{ id: "r2", automationId: "z", trigger: "manual", startedAt: 9, finishedAt: null, status: "running", sessionId: null, sessionFile: null, error: null }] },
    changed: true,
  }), path);
  assert.equal(readAutomations(path).runs.length, 1);
});

test("runsOf sorts newest first; runs in progress are visible", async () => {
  await editAutomations(() => ({
    file: {
      automations: [],
      runs: [
        { id: "old", automationId: "a1", trigger: "schedule", startedAt: 1, finishedAt: 2, status: "done", sessionId: null, sessionFile: null, error: null },
        { id: "new", automationId: "a1", trigger: "manual", startedAt: 9, finishedAt: null, status: "running", sessionId: "s9", sessionFile: null, error: null },
      ],
    },
    changed: true,
  }), path);
  assert.deepEqual(runsOf(readAutomations(path)).map((run) => run.id), ["new", "old"]);
  assert.equal(fileHasRunsInProgress(readAutomations(path), "a1"), true);
  assert.equal(fileHasRunsInProgress(readAutomations(path), "other"), false);
});

test("the run history is capped on write", async () => {
  const many = Array.from({ length: RUN_HISTORY_LIMIT + 20 }, (_, index) => ({
    id: `r${index}`, automationId: "a1", trigger: "schedule", startedAt: index, finishedAt: index + 1,
    status: "done", sessionId: null, sessionFile: null, error: null,
  }));
  await editAutomations(() => ({ file: { automations: [], runs: many }, changed: true }), path);
  assert.equal(readAutomations(path).runs.length, RUN_HISTORY_LIMIT);
  // The newest survive.
  assert.ok(readAutomations(path).runs.some((run) => run.id === `r${RUN_HISTORY_LIMIT + 19}`));
});
