import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { archiveAutomationSession } = await jiti.import("./archive.ts");
const { readSessionUiState, resetSessionUiStateCacheForTests } = await jiti.import("../session-ui-state.ts");

const dir = mkdtempSync(join(tmpdir(), "pi-web-automations-archive-"));
test.after(() => {
  resetSessionUiStateCacheForTests();
  rmSync(dir, { recursive: true, force: true });
});

test("a finished run's session is archived through the sidebar's own state", async () => {
  const path = join(dir, "ui-state.json");
  const before = Date.now();
  assert.equal(await archiveAutomationSession("run-session-1", path), true);

  const state = readSessionUiState(path);
  const family = state.sessions["run-session-1"];
  assert.ok(family, "the session has an entry");
  assert.ok(Number.isFinite(family.archivedAt) && family.archivedAt >= before, "archived now");
  assert.equal(family.pinnedAt, undefined, "archiving unpins, as the sidebar's Archive does");
});

test("archiving again refreshes the time, so a session that came back can be archived again", async () => {
  const path = join(dir, "again.json");
  await archiveAutomationSession("run-session-2", path);
  const first = readSessionUiState(path).sessions["run-session-2"].archivedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await archiveAutomationSession("run-session-2", path);
  const second = readSessionUiState(path).sessions["run-session-2"].archivedAt;
  assert.ok(second > first, "archiving again writes a newer time");
});

test("an empty id writes nothing; an unwritable state file is reported, not thrown", async () => {
  const missing = join(dir, "never-written.json");
  assert.equal(await archiveAutomationSession("", missing), false);
  assert.equal(existsSync(missing), false);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    // A directory where the state file should be: the atomic replace cannot land.
    assert.equal(await archiveAutomationSession("run-session-3", dir), false);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /archiving the run's session failed/);
});
