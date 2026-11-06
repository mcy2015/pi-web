import assert from "node:assert/strict";
import test from "node:test";
import { BTW_NOTE_CUSTOM_TYPE, parseBtwNoteDetails } from "./btw-note.ts";

test("parses a captured pi-btw details payload", () => {
  const note = parseBtwNoteDetails({
    question: "What is 2+2?",
    answer: "**4**, as always.",
    thinking: "reasoning the extension keeps out of the card",
    provider: "zai-coding-cn",
    model: "glm-5.3",
    api: "openai-completions",
    thinkingLevel: "max",
    timestamp: 1793942213452,
    usage: {
      input: 101,
      output: 76,
      cacheRead: 4736,
      cacheWrite: 0,
      reasoning: 51,
      totalTokens: 4913,
      cost: { total: 0.0017 },
    },
    workspaceIdentity: "local:/tmp/project",
  });

  assert.deepEqual(note, {
    question: "What is 2+2?",
    answer: "**4**, as always.",
    provider: "zai-coding-cn",
    model: "glm-5.3",
    api: "openai-completions",
    thinkingLevel: "max",
    timestamp: 1793942213452,
    usage: {
      input: 101,
      output: 76,
      cacheRead: 4736,
      cacheWrite: 0,
      reasoning: 51,
      totalTokens: 4913,
      cost: { total: 0.0017 },
    },
  });
});

test("returns null when there is no question and answer to show", () => {
  assert.equal(parseBtwNoteDetails(undefined), null);
  assert.equal(parseBtwNoteDetails(null), null);
  assert.equal(parseBtwNoteDetails("**Question**\n\n…"), null);
  assert.equal(parseBtwNoteDetails([]), null);
  // A payload without any Q&A text cannot drive the card.
  assert.equal(parseBtwNoteDetails({}), null);
  assert.equal(parseBtwNoteDetails({ question: "", answer: "" }), null);
  assert.equal(
    parseBtwNoteDetails({ provider: "zai-coding-cn", model: "glm-5.3", usage: { totalTokens: 100 } }),
    null,
  );
});

test("keeps a partial payload, dropping malformed fields", () => {
  const note = parseBtwNoteDetails({
    question: "Only a question?",
    answer: "",
    provider: 42,
    model: "glm-5.3",
    timestamp: Number.POSITIVE_INFINITY,
    usage: "not an object",
  });

  assert.deepEqual(note, {
    question: "Only a question?",
    answer: "",
    provider: undefined,
    model: "glm-5.3",
    api: undefined,
    thinkingLevel: undefined,
    timestamp: undefined,
    usage: undefined,
  });
});

test("drops non-finite and negative usage numbers", () => {
  const note = parseBtwNoteDetails({
    question: "q",
    answer: "a",
    usage: {
      input: "101",
      output: -76,
      cacheRead: 4736,
      totalTokens: Number.NaN,
      cost: { total: "0.0017" },
    },
  });

  assert.deepEqual(note.usage, {
    input: undefined,
    output: -76,
    cacheRead: 4736,
    cacheWrite: undefined,
    reasoning: undefined,
    totalTokens: undefined,
    cost: { total: undefined },
  });
});

test("the custom type is the extension's", () => {
  assert.equal(BTW_NOTE_CUSTOM_TYPE, "btw-note");
});
