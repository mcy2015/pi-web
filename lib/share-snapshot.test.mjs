import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  snapshotTitle,
  firstUserText,
  MAX_SHARE_SNAPSHOT_BYTES,
  ShareSnapshotError,
} = await jiti.import("./share-snapshot.ts");

test("firstUserText takes the first user message's text", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "hello?" }] },
    { role: "user", content: [{ type: "image", source: { type: "base64", data: "xx" } }, { type: "text", text: "look at this" }] },
    { role: "user", content: "later message" },
  ];
  assert.equal(firstUserText(messages), "look at this");
  assert.equal(firstUserText([{ role: "user", content: "plain" }]), "plain");
  assert.equal(firstUserText([]), "");
});

test("snapshotTitle prefers the name, then the first message, truncated", () => {
  assert.equal(snapshotTitle("Named", [{ role: "user", content: "hi" }], "sid"), "Named");
  assert.equal(snapshotTitle(undefined, [{ role: "user", content: "How do I fix the flaky test?" }], "sid"), "How do I fix the flaky test?");
  const long = "x".repeat(200);
  const title = snapshotTitle(undefined, [{ role: "user", content: long }], "sid");
  assert.equal(title.length, 81);
  assert.ok(title.endsWith("…"));
  assert.equal(snapshotTitle(undefined, [], "abc12345"), "abc12345");
});

test("the size ceiling is 25 MB and the error carries its code", () => {
  assert.equal(MAX_SHARE_SNAPSHOT_BYTES, 25 * 1024 * 1024);
  const error = new ShareSnapshotError("too_large", "too big");
  assert.equal(error.code, "too_large");
  assert.equal(new ShareSnapshotError("session_not_found", "nope").code, "session_not_found");
});
