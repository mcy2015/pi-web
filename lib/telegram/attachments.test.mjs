import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { classifyDocument, buildDocumentPrompt } = await jiti.import("./attachments.ts");

// ---- classifyDocument ----

test("image mimes classify as image", () => {
  assert.deepEqual(classifyDocument({ fileName: "pic.png", mimeType: "image/png", fileSize: 500_000 }), { kind: "image" });
  assert.deepEqual(classifyDocument({ fileName: "photo.jpg", mimeType: "image/jpeg" }), { kind: "image" });
});

test("text mimes classify as text", () => {
  assert.deepEqual(classifyDocument({ fileName: "note.txt", mimeType: "text/plain" }), { kind: "text" });
  assert.deepEqual(classifyDocument({ fileName: "data.json", mimeType: "application/json" }), { kind: "text" });
});

test("text extensions classify as text even without a mime", () => {
  assert.deepEqual(classifyDocument({ fileName: "main.ts" }), { kind: "text" });
  assert.deepEqual(classifyDocument({ fileName: "Script.PY" }), { kind: "text" }); // case-insensitive
  assert.deepEqual(classifyDocument({ fileName: ".gitignore" }), { kind: "text" }); // dotfile: the "extension" is the name
  assert.deepEqual(classifyDocument({ fileName: "Dockerfile" }), { kind: "text" }); // extension-less known name
  assert.deepEqual(classifyDocument({ fileName: "config.spec.yml" }), { kind: "text" });
});

test("a file over 1 MB is refused by size before any type check", () => {
  assert.deepEqual(
    classifyDocument({ fileName: "big.png", mimeType: "image/png", fileSize: 1_048_577 }),
    { kind: "unsupported", reason: "size" },
  );
  assert.deepEqual(
    classifyDocument({ fileName: "big.txt", mimeType: "text/plain", fileSize: 2 * 1_048_576 }),
    { kind: "unsupported", reason: "size" },
  );
  // Exactly at the cap still passes the type checks.
  assert.deepEqual(classifyDocument({ fileName: "ok.txt", mimeType: "text/plain", fileSize: 1_048_576 }), { kind: "text" });
});

test("unknown extensions and mimes are refused", () => {
  assert.deepEqual(classifyDocument({ fileName: "archive.zip", mimeType: "application/zip" }), { kind: "unsupported", reason: "type" });
  assert.deepEqual(classifyDocument({ fileName: "report.pdf", mimeType: "application/pdf" }), { kind: "unsupported", reason: "type" });
  assert.deepEqual(classifyDocument({ fileName: "clip.mp4" }), { kind: "unsupported", reason: "type" });
});

test("no mime and no known extension falls through to a type refusal", () => {
  assert.deepEqual(classifyDocument({ fileName: "someblob" }), { kind: "unsupported", reason: "type" });
  assert.deepEqual(classifyDocument({}), { kind: "unsupported", reason: "type" });
});

test("a generic binary blob is called out as binary", () => {
  assert.deepEqual(
    classifyDocument({ fileName: "payload", mimeType: "application/octet-stream" }),
    { kind: "unsupported", reason: "binary" },
  );
});

// ---- buildDocumentPrompt ----

test("the prompt wraps the caption, header and a plain fence", () => {
  const { prompt, truncated } = buildDocumentPrompt("notes.txt", "hello\nworld", "Summarize this");
  assert.equal(truncated, false);
  assert.equal(prompt, "Summarize this\n📄 notes.txt:\n```\nhello\nworld\n```");
});

test("an empty caption falls back to the stand-in lead", () => {
  const { prompt } = buildDocumentPrompt("notes.txt", "hello", "");
  assert.ok(prompt.startsWith("Please use this file.\n📄 notes.txt:\n```\n"));
  assert.ok(buildDocumentPrompt("notes.txt", "hello", "   ").prompt.startsWith("Please use this file."));
});

test("the fence extends past the longest backtick run in the content", () => {
  const { prompt } = buildDocumentPrompt("fence.md", "before ``` mid ```` after ` end", "");
  // Longest run is 4, so the fence is 5 — a 3-run fence would let the content break out.
  assert.ok(prompt.endsWith("before ``` mid ```` after ` end\n`````"));
  assert.ok(prompt.includes("Please use this file.\n📄 fence.md:\n`````\nbefore"));
  assert.ok(!prompt.includes("\n```\n"));
});

test("over-long content keeps its head plus a truncation note", () => {
  const content = "ab".repeat(15_000); // 30 000 chars
  const { prompt, truncated } = buildDocumentPrompt("long.log", content, "", 1_000);
  assert.equal(truncated, true);
  assert.ok(prompt.includes(`${content.slice(0, 1_000).trimEnd()}\n… (truncated, 30000 chars total)`));
  // The head and the note stay inside one fence: exactly two fence lines.
  const fenceLines = prompt.split("\n").filter((line) => line === "```");
  assert.equal(fenceLines.length, 2);
});
