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
  parseConfig,
  readTelegramConfig,
  readTelegramState,
  telegramConfigPath,
  telegramStatePath,
  tokenHint,
} = await jiti.import("./config-store.ts");

const dir = mkdtempSync(join(tmpdir(), "pi-web-telegram-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const configPath = telegramConfigPath(dir);
const statePath = telegramStatePath(dir);

test("parseConfig keeps only well-formed values", () => {
  const parsed = parseConfig({
    token: " 123:abc ",
    enabled: "yes",
    defaultCwd: "  ",
    allowedChats: [
      { id: 42, title: "Hen" },
      { id: "43" },
      "nope",
      { id: 44, title: 7 },
      null,
    ],
  });
  assert.deepEqual(parsed, {
    token: "123:abc",
    enabled: false,
    defaultCwd: null,
    allowedChats: [{ id: 42, title: "Hen" }, { id: 44, title: null }],
  });
});

test("config: edit writes atomically and reads back", async () => {
  assert.deepEqual(readTelegramConfig(configPath), { token: "", enabled: false, defaultCwd: null, allowedChats: [] });
  await editTelegramConfig(() => ({
    config: { token: "1:tok", enabled: true, defaultCwd: "/work", allowedChats: [{ id: 7, title: "chat" }] },
    changed: true,
  }), configPath);
  assert.deepEqual(readTelegramConfig(configPath), {
    token: "1:tok",
    enabled: true,
    defaultCwd: "/work",
    allowedChats: [{ id: 7, title: "chat" }],
  });
  // An edit that changes nothing leaves the file alone.
  const before = readTelegramConfig(configPath);
  await editTelegramConfig((current) => ({ config: current, changed: false }), configPath);
  assert.deepEqual(readTelegramConfig(configPath), before);
});

test("state: bindings survive a round trip", async () => {
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
  await editTelegramConfig(() => ({ config: { token: "2:tok", enabled: false, defaultCwd: null, allowedChats: [] }, changed: true }), configPath);
  assert.equal(readTelegramConfig(configPath).token, "2:tok");
});

test("tokenHint shows the last four characters only", () => {
  assert.equal(tokenHint("1234567890:AAEXYzhk"), "Yzhk");
  assert.equal(tokenHint(""), null);
  assert.equal(tokenHint("short"), null);
});
