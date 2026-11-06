import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  getWebSettingsPath,
  readAutoNameSessionsEnabled,
  readWebSettings,
  resolveAutoNameSessions,
  writeAutoNameSessionsEnabled,
} = await jiti.import("./web-settings-file.ts");

async function tempSettingsPath() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-settings-"));
  return { dir, path: join(dir, "pi-web-settings.json") };
}

test("autoNameSessions is on unless the file turns it off", async () => {
  const { dir } = await tempSettingsPath();
  try {
    assert.equal(resolveAutoNameSessions({}), true);
    assert.equal(resolveAutoNameSessions({ autoNameSessions: true }), true);
    assert.equal(resolveAutoNameSessions({ autoNameSessions: false }), false);
    // A missing file reads as on: the default needs no file.
    assert.equal(readAutoNameSessionsEnabled(join(dir, "pi-web-settings.json")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("turning it off writes false; turning it on removes the key", async () => {
  const { dir, path } = await tempSettingsPath();
  try {
    // On with no file creates nothing, like /api/cache-miss-notices.
    assert.equal(await writeAutoNameSessionsEnabled(true, path), true);
    assert.equal(await readFile(path, "utf8").then(() => true, () => false), false);

    assert.equal(await writeAutoNameSessionsEnabled(false, path), false);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { autoNameSessions: false });
    assert.equal(readAutoNameSessionsEnabled(path), false);

    assert.equal(await writeAutoNameSessionsEnabled(true, path), true);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {});
    assert.equal(readAutoNameSessionsEnabled(path), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown keys are kept and a non-boolean autoNameSessions is ignored", async () => {
  const { dir, path } = await tempSettingsPath();
  try {
    await writeFile(path, JSON.stringify({ newerBuild: { keep: 1 }, autoNameSessions: "yes" }, null, 2), "utf8");
    assert.deepEqual(readWebSettings(path), {});
    assert.equal(readAutoNameSessionsEnabled(path), true);

    assert.equal(await writeAutoNameSessionsEnabled(false, path), false);
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.autoNameSessions, false);
    assert.deepEqual(raw.newerBuild, { keep: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a file that cannot be parsed reads as the defaults and the next write repairs it", async () => {
  const { dir, path } = await tempSettingsPath();
  try {
    await writeFile(path, "{not json", "utf8");
    assert.equal(readAutoNameSessionsEnabled(path), true);

    assert.equal(await writeAutoNameSessionsEnabled(false, path), false);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { autoNameSessions: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a file holding valid JSON that is not an object reads as the defaults too", async () => {
  const { dir, path } = await tempSettingsPath();
  try {
    await writeFile(path, "[\"autoNameSessions\"]", "utf8");
    assert.deepEqual(readWebSettings(path), {});
    assert.equal(readAutoNameSessionsEnabled(path), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the settings file lives beside pi's own files in the agent dir", () => {
  assert.ok(getWebSettingsPath("/agent-dir").endsWith(join("agent-dir", "pi-web-settings.json")));
});
