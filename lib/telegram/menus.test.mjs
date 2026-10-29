import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  MENU_CANCEL_INDEX,
  TelegramMenuRegistry,
  buildMenuKeyboard,
  encodeMenuCallback,
  newMenuToken,
  parseMenuCallback,
} = await jiti.import("./menus.ts");

test("encodeMenuCallback/parseMenuCallback round-trip", () => {
  assert.equal(encodeMenuCallback("model", "ab12", 3), "m:model:ab12:3");
  assert.deepEqual(parseMenuCallback("m:model:ab12:3"), { kind: "model", token: "ab12", index: 3 });
  assert.deepEqual(parseMenuCallback("m:think:zz9:0"), { kind: "think", token: "zz9", index: 0 });
  // The reserved cancel index round-trips too, and stays far under the
  // 64-byte callback_data cap.
  assert.equal(encodeMenuCallback("think", "ab12", -1), "m:think:ab12:-1");
  assert.equal(parseMenuCallback("m:think:ab12:-1").index, -1);
  assert.ok(encodeMenuCallback("project", "zzzz", 999).length <= 64);
});

test("parseMenuCallback rejects anything that is not a well-formed menu callback", () => {
  assert.equal(parseMenuCallback("ui:abc:1"), null);
  assert.equal(parseMenuCallback("m:model:ab12"), null); // three parts
  assert.equal(parseMenuCallback("m:model:ab12:3:4"), null); // five parts
  assert.equal(parseMenuCallback("m:model:ab12:x"), null); // not an integer
  assert.equal(parseMenuCallback("m:model:ab12:3.5"), null);
  assert.equal(parseMenuCallback("m:model:ab12:+3"), null);
  assert.equal(parseMenuCallback("m:model:ab12:"), null);
  // An empty token still parses (four parts, integer index); the registry lookup rejects it.
  assert.deepEqual(parseMenuCallback("m:model::3"), { kind: "model", token: "", index: 3 });
  assert.equal(parseMenuCallback(""), null);
  assert.equal(parseMenuCallback("xm:model:ab12:3"), null); // strict prefix
});

test("newMenuToken is a short base36 string", () => {
  for (let i = 0; i < 50; i++) assert.match(newMenuToken(), /^[0-9a-z]{4}$/);
});

test("TelegramMenuRegistry: the matching token is consumed exactly once", () => {
  const registry = new TelegramMenuRegistry();
  const options = [{ id: "p/a", label: "A" }];
  const token = registry.issue(1, "model", options, 42);
  assert.deepEqual(registry.take(1, "model", token), { options, messageId: 42 });
  assert.equal(registry.take(1, "model", token), null);
});

test("TelegramMenuRegistry: a wrong token or chat does not consume the entry", () => {
  const registry = new TelegramMenuRegistry();
  const options = [{ id: "p/a", label: "A" }];
  const token = registry.issue(1, "model", options, 42);
  assert.equal(registry.take(1, "model", "nope"), null);
  assert.equal(registry.take(2, "model", token), null); // another chat's menu
  assert.deepEqual(registry.take(1, "model", token), { options, messageId: 42 });
});

test("TelegramMenuRegistry: a fresh issue of the same chat+kind invalidates the old token", () => {
  const registry = new TelegramMenuRegistry();
  const first = registry.issue(1, "model", [{ id: "p/a", label: "A" }], 10);
  const second = registry.issue(1, "model", [{ id: "p/b", label: "B" }], 11);
  assert.notEqual(first, second);
  assert.equal(registry.take(1, "model", first), null);
  assert.deepEqual(registry.take(1, "model", second), { options: [{ id: "p/b", label: "B" }], messageId: 11 });
});

test("TelegramMenuRegistry: entries expire after the TTL", () => {
  let now = 1_000_000;
  const registry = new TelegramMenuRegistry(() => now);
  const token = registry.issue(1, "think", [{ id: "low", label: "low" }], 5);
  now += 10 * 60_000;
  assert.equal(registry.take(1, "think", token), null);
  // Only the expired entry died; later menus keep working.
  const fresh = registry.issue(1, "model", [{ id: "p/a", label: "A" }], 6);
  assert.deepEqual(registry.take(1, "model", fresh), { options: [{ id: "p/a", label: "A" }], messageId: 6 });
});

test("TelegramMenuRegistry: over-cap entries are dropped oldest-first", () => {
  const registry = new TelegramMenuRegistry();
  const first = registry.issue(1, "model", [{ id: "p/a", label: "A" }], 1);
  let last = "";
  for (let chatId = 2; chatId <= 101; chatId++) {
    last = registry.issue(chatId, "model", [{ id: `p/m${chatId}`, label: `M${chatId}` }], chatId);
  }
  assert.equal(registry.take(1, "model", first), null);
  assert.deepEqual(registry.take(101, "model", last), { options: [{ id: "p/m101", label: "M101" }], messageId: 101 });
});

test("buildMenuKeyboard: one option per row plus a cancel row, labels truncated at 60", () => {
  const keyboard = buildMenuKeyboard("model", "tok1", [
    { id: "p/short", label: "Short" },
    { id: "p/long", label: "x".repeat(80) },
  ]);
  assert.equal(keyboard.length, 3);
  assert.deepEqual(keyboard[0], [{ text: "Short", callback_data: "m:model:tok1:0" }]);
  assert.equal(keyboard[1][0].text.length, 60);
  assert.ok(keyboard[1][0].text.endsWith("…"));
  assert.equal(keyboard[1][0].callback_data, "m:model:tok1:1");
  assert.deepEqual(keyboard[2], [{ text: "Cancel", callback_data: "m:model:tok1:-1" }]);
  assert.equal(MENU_CANCEL_INDEX, -1);
});

test("buildMenuKeyboard: currentId marks only the matching option; cancelLabel overrides", () => {
  const keyboard = buildMenuKeyboard(
    "think",
    "tok1",
    [{ id: "off", label: "off" }, { id: "high", label: "high" }],
    { currentId: "high", cancelLabel: "Keep it" },
  );
  assert.equal(keyboard[0][0].text, "off");
  assert.equal(keyboard[1][0].text, "✅ high");
  assert.equal(keyboard[2][0].text, "Keep it");
  assert.equal(keyboard[2][0].callback_data, "m:think:tok1:-1");
});
