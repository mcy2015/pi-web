import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  editTelegramConfig,
  editTelegramState,
  parseTelegramConfig,
  readTelegramConfig,
  readTelegramState,
  channelsConfigPath,
  channelsStatePath,
  tokenHint,
} = await jiti.import("./config-store.ts");

const dir = mkdtempSync(join(tmpdir(), "pi-web-channels-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const configPath = channelsConfigPath(dir);
const statePath = channelsStatePath(dir);

test("parseTelegramConfig keeps only well-formed values", () => {
  const parsed = parseTelegramConfig({
    token: " 123:abc ",
    enabled: "yes",
    defaultCwd: "  ",
    allowedChats: [
      { id: 42, title: "Hen", cwd: "/work/hen" },
      { id: "43" },
      "nope",
      { id: 44, title: 7 },
      { id: 45, cwd: "   " },
      null,
    ],
  });
  assert.deepEqual(parsed, {
    token: "123:abc",
    enabled: false,
    defaultCwd: null,
    allowedChats: [
      { id: 42, title: "Hen", cwd: "/work/hen" },
      { id: 44, title: null, cwd: null },
      { id: 45, title: null, cwd: null },
    ],
  });
  assert.deepEqual(parseTelegramConfig(null), { token: "", enabled: false, defaultCwd: null, allowedChats: [] });
});

test("config: edit writes the telegram section and keeps other channels", async () => {
  assert.deepEqual(readTelegramConfig(configPath), { token: "", enabled: false, defaultCwd: null, allowedChats: [] });
  await editTelegramConfig(() => ({
    config: { token: "1:tok", enabled: true, defaultCwd: "/work", allowedChats: [{ id: 7, title: "chat", cwd: null }] },
    changed: true,
  }), configPath);
  assert.deepEqual(readTelegramConfig(configPath), {
    token: "1:tok",
    enabled: true,
    defaultCwd: "/work",
    allowedChats: [{ id: 7, title: "chat", cwd: null }],
  });
  // A future channel's section survives a telegram edit untouched.
  const raw = JSON.parse((await import("node:fs")).readFileSync(configPath, "utf8"));
  raw.discord = { token: "x" };
  (await import("node:fs")).writeFileSync(configPath, JSON.stringify(raw));
  await editTelegramConfig((current) => ({ config: { ...current, token: "2:tok" }, changed: true }), configPath);
  const raw2 = JSON.parse((await import("node:fs")).readFileSync(configPath, "utf8"));
  assert.deepEqual(raw2.discord, { token: "x" });
  assert.equal(raw2.telegram.token, "2:tok");

  // An edit that changes nothing leaves the file alone.
  const before = readTelegramConfig(configPath);
  await editTelegramConfig((current) => ({ config: current, changed: false }), configPath);
  assert.deepEqual(readTelegramConfig(configPath), before);
});

test("state: bindings survive a round trip inside the telegram section", async () => {
  await editTelegramState((state) => ({
    state: {
      ...state,
      offset: 100,
      chats: { "7": { sessionId: "abc", sessionFile: "/sessions/abc.jsonl" } },
      lastUnknownChat: { id: 9, title: "Someone", at: 123 },
    },
    changed: true,
  }), statePath);
  const read = readTelegramState(statePath);
  assert.equal(read.offset, 100);
  assert.deepEqual(read.chats["7"], { sessionId: "abc", sessionFile: "/sessions/abc.jsonl" });
  assert.deepEqual(read.lastUnknownChat, { id: 9, title: "Someone", at: 123 });
});

test("a corrupt file is set aside, not returned and not overwritten", async () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, "{not json", { mode: 0o600 });
  const fresh = readTelegramConfig(configPath);
  assert.deepEqual(fresh, { token: "", enabled: false, defaultCwd: null, allowedChats: [] });
  await editTelegramConfig(() => ({ config: { token: "3:tok", enabled: false, defaultCwd: null, allowedChats: [] }, changed: true }), configPath);
  assert.equal(readTelegramConfig(configPath).token, "3:tok");
});

test("a legacy pi-web-telegram.json migrates once into the channels file", async () => {
  const legacyDir = mkdtempSync(join(tmpdir(), "pi-web-telegram-legacy-"));
  try {
    const newPath = channelsConfigPath(legacyDir);
    const legacyPath = join(legacyDir, "pi-web-telegram.json");
    writeFileSync(legacyPath, JSON.stringify({
      token: "9:legacy",
      enabled: true,
      defaultCwd: null,
      allowedChats: [{ id: 5, title: "old" }],
    }));
    const migrated = readTelegramConfig(newPath);
    assert.equal(migrated.token, "9:legacy");
    assert.equal(migrated.enabled, true);
    assert.deepEqual(migrated.allowedChats, [{ id: 5, title: "old", cwd: null }]);
    // The second read no longer finds the legacy file: it was renamed aside.
    await editTelegramConfig((current) => ({ config: { ...current, token: "10:next" }, changed: true }), newPath);
    assert.equal(readTelegramConfig(newPath).token, "10:next");
  } finally {
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

test("tokenHint shows the last four characters only", () => {
  assert.equal(tokenHint("1234567890:AAEXYzhk"), "Yzhk");
  assert.equal(tokenHint(""), null);
  assert.equal(tokenHint("short"), null);
});
