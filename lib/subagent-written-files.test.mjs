import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { collectSubagentSources, extractSessionWrittenFiles } = await jiti.import("./subagent-written-files.ts");

function assistantWithCall(id, toolName) {
  return { role: "assistant", content: [{ type: "toolCall", toolCallId: id, toolName, input: {} }] };
}

function subagentResult(toolCallId, details) {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text: "done" }], details };
}

const DETAILS = (overrides = {}) => ({
  kind: "pi-web-subagent",
  sessionId: "child-1",
  profile: "worker",
  description: "fix things",
  status: "completed",
  runInBackground: true,
  createdAt: "2026-10-27T00:00:00Z",
  ...overrides,
});

test("collects settled subagent sessions from tool results", () => {
  const messages = [
    { role: "user", content: "go" },
    assistantWithCall("1", "subagent"),
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  const toolResults = new Map([["1", subagentResult("1", DETAILS())]]);
  assert.deepEqual(collectSubagentSources(messages, toolResults), [
    { sessionId: "child-1", cwd: undefined },
  ]);
});

test("a running subagent is not collected until it settles", () => {
  const messages = [assistantWithCall("1", "subagent")];
  for (const status of ["starting", "queued", "running"]) {
    const toolResults = new Map([["1", subagentResult("1", DETAILS({ status }))]]);
    assert.deepEqual(collectSubagentSources(messages, toolResults), [], status);
  }
  for (const status of ["completed", "failed", "aborted", "interrupted"]) {
    const toolResults = new Map([["1", subagentResult("1", DETAILS({ status }))]]);
    assert.equal(collectSubagentSources(messages, toolResults).length, 1, status);
  }
});

test("a worktree subagent carries its checkout as cwd", () => {
  const messages = [assistantWithCall("1", "subagent")];
  const toolResults = new Map([["1", subagentResult("1", DETAILS({ worktreePath: "/repo/.worktrees/fix" }))]]);
  assert.deepEqual(collectSubagentSources(messages, toolResults), [
    { sessionId: "child-1", cwd: "/repo/.worktrees/fix" },
  ]);
});

test("the same subagent session is collected once per scan", () => {
  const messages = [assistantWithCall("1", "subagent"), assistantWithCall("2", "subagent")];
  const toolResults = new Map([
    ["1", subagentResult("1", DETAILS())],
    ["2", subagentResult("2", DETAILS())],
  ]);
  assert.equal(collectSubagentSources(messages, toolResults).length, 1);
});

test("non-subagent tool details are ignored", () => {
  const messages = [
    assistantWithCall("1", "bash"),
    assistantWithCall("2", "subagent"),
  ];
  const toolResults = new Map([
    ["1", subagentResult("1", { kind: "other", sessionId: "x" })],
    ["2", subagentResult("2", { some: "shape" })],
  ]);
  assert.deepEqual(collectSubagentSources(messages, toolResults), []);
});

test("extractSessionWrittenFiles resolves against the child cwd", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "toolCall", toolCallId: "w1", toolName: "write", input: { path: "src/out.ts" } }] },
    { role: "toolResult", toolCallId: "w1", content: [{ type: "text", text: "ok" }] },
  ];
  const toolResults = new Map([["w1", messages[2]]]);
  const files = extractSessionWrittenFiles(messages, toolResults, "/repo/.worktrees/fix");
  assert.deepEqual(files, [{ filePath: "/repo/.worktrees/fix/src/out.ts" }]);
});
