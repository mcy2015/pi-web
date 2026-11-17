import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  TOOL_CALL_GROUP_MIN,
  groupConsecutiveToolCalls,
  toolCallHasError,
} = await jiti.import("./tool-call-grouping.ts");

function call(toolCallId, toolName = "read") {
  return { type: "toolCall", toolCallId, toolName, input: { path: `${toolCallId}.ts` } };
}

function result(toolCallId, content = [{ type: "text", text: "done" }]) {
  return { role: "toolResult", toolCallId, content };
}

function items(...blocks) {
  return blocks.map((block, originalIndex) => ({ block, originalIndex }));
}

function results(...rs) {
  return new Map(rs.map((r) => [r.toolCallId, r]));
}

/** What assertions compare: a segment's kind plus what identifies it. */
function outline(segments) {
  return segments.map((segment) => segment.kind === "toolCallGroup"
    ? { group: segment.toolName, first: segment.firstOriginalIndex, count: segment.items.length }
    : { block: segment.block.type, originalIndex: segment.originalIndex });
}

const loose = (...blocks) => blocks.map((block, originalIndex) => ({ block: block.type, originalIndex }));

test("toolCallHasError reads the result's isError and apply_patch's per-file failures", () => {
  const patch = call("p1", "apply_patch");
  // No result, or a clean one.
  assert.equal(toolCallHasError(patch), false);
  assert.equal(toolCallHasError(patch, result("p1")), false);
  // isError on the result, whatever the tool.
  assert.equal(toolCallHasError(patch, { ...result("p1"), isError: true }), true);
  assert.equal(toolCallHasError(call("p2", "read"), { ...result("p2"), isError: true }), true);
  // apply_patch reports failures on details.result instead of isError.
  assert.equal(toolCallHasError(patch, { ...result("p1"), details: { result: { failures: ["a.ts"] } } }), true);
  assert.equal(toolCallHasError(patch, { ...result("p1"), details: { result: { appliedFiles: ["a.ts"] } } }), false);
  // The same details on another tool mean nothing.
  assert.equal(toolCallHasError(call("p3", "read"), { ...result("p3"), details: { result: { failures: ["a.ts"] } } }), false);
});

test("a run of the minimum size folds; one below it stays loose", () => {
  assert.equal(TOOL_CALL_GROUP_MIN, 3);
  const two = items(call("a"), call("b"));
  assert.deepEqual(outline(groupConsecutiveToolCalls(two, results(result("a"), result("b")))), loose(call("a"), call("b")));
  const three = items(call("a"), call("b"), call("c"));
  assert.deepEqual(outline(groupConsecutiveToolCalls(three, results(result("a"), result("b"), result("c")))), [
    { group: "read", first: 0, count: 3 },
  ]);
  const fiveIds = ["a", "b", "c", "d", "e"];
  const five = items(...fiveIds.map((id) => call(id)));
  assert.deepEqual(
    outline(groupConsecutiveToolCalls(five, results(...fiveIds.map((id) => result(id))))),
    [{ group: "read", first: 0, count: 5 }],
  );
});

test("minGroupSize raises the bar", () => {
  const fourIds = ["a", "b", "c", "d"];
  const four = items(...fourIds.map((id) => call(id)));
  assert.deepEqual(
    outline(groupConsecutiveToolCalls(four, results(...fourIds.map((id) => result(id))), { minGroupSize: 5 })),
    loose(...fourIds.map((id) => call(id))),
  );
  const fiveIds = ["a", "b", "c", "d", "e"];
  const five = items(...fiveIds.map((id) => call(id)));
  const grouped = groupConsecutiveToolCalls(five, results(...fiveIds.map((id) => result(id))), { minGroupSize: 5 });
  assert.deepEqual(outline(grouped), [{ group: "read", first: 0, count: 5 }]);
});

test("a run breaks on a different tool name or a text block between calls", () => {
  const mixed = items(call("a"), call("b"), call("c", "bash"), call("d", "bash"), call("e", "bash"));
  assert.deepEqual(outline(groupConsecutiveToolCalls(mixed, results(result("a"), result("b"), result("c"), result("d"), result("e")))), [
    { block: "toolCall", originalIndex: 0 },
    { block: "toolCall", originalIndex: 1 },
    { group: "bash", first: 2, count: 3 },
  ]);

  const text = { type: "text", text: "done reading" };
  const split = items(call("a"), call("b"), call("c"), text, call("d"), call("e"), call("f"));
  assert.deepEqual(outline(groupConsecutiveToolCalls(split, results(result("a"), result("b"), result("c"), result("d"), result("e"), result("f")))), [
    { group: "read", first: 0, count: 3 },
    { block: "text", originalIndex: 3 },
    { group: "read", first: 4, count: 3 },
  ]);
});

test("an originalIndex gap breaks the run: a filtered empty thinking block sits between", () => {
  const gapped = [
    { block: call("a"), originalIndex: 0 },
    { block: call("b"), originalIndex: 1 },
    { block: call("c"), originalIndex: 3 },
    { block: call("d"), originalIndex: 4 },
  ];
  // All loose, and the indices keep their gap (unlike `loose`, which renumbers).
  assert.deepEqual(outline(groupConsecutiveToolCalls(gapped, results(result("a"), result("b"), result("c"), result("d")))), [
    { block: "toolCall", originalIndex: 0 },
    { block: "toolCall", originalIndex: 1 },
    { block: "toolCall", originalIndex: 3 },
    { block: "toolCall", originalIndex: 4 },
  ]);
});

test("an error call stays loose and splits the runs around it", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const tail = items(...ids.map((id) => call(id)));
  assert.deepEqual(outline(groupConsecutiveToolCalls(tail, results(result("a"), result("b"), result("c"), result("d"), { ...result("e"), isError: true }))), [
    { group: "read", first: 0, count: 4 },
    { block: "toolCall", originalIndex: 4 },
  ]);

  const aroundIds = ["a", "b", "err", "c", "d"];
  const around = items(...aroundIds.map((id) => call(id)));
  assert.deepEqual(
    outline(groupConsecutiveToolCalls(around, results(result("a"), result("b"), { ...result("err"), isError: true }, result("c"), result("d")))),
    loose(...aroundIds.map((id) => call(id))),
  );
});

test("a message whose results have not all arrived never folds", () => {
  const ids = ["a", "b", "c", "d"];
  // One result missing.
  assert.deepEqual(
    outline(groupConsecutiveToolCalls(items(...ids.map((id) => call(id))), results(result("a"), result("b"), result("c")))),
    loose(...ids.map((id) => call(id))),
  );
  // No map at all.
  assert.deepEqual(
    outline(groupConsecutiveToolCalls(items(...ids.map((id) => call(id))))),
    loose(...ids.map((id) => call(id))),
  );
});

test("a result with an image stays unfolded: collapsing cannot hide it", () => {
  const ids = ["a", "b", "c"];
  const withImage = results(
    result("a"),
    { role: "toolResult", toolCallId: "b", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }] },
    result("c"),
  );
  assert.deepEqual(
    outline(groupConsecutiveToolCalls(items(...ids.map((id) => call(id))), withImage)),
    loose(...ids.map((id) => call(id))),
  );
});

test("a streaming message keeps every card", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual(
    outline(groupConsecutiveToolCalls(items(...ids.map((id) => call(id))), results(...ids.map((id) => result(id))), { isStreaming: true })),
    loose(...ids.map((id) => call(id))),
  );
});

test("one message can hold two groups around a text block", () => {
  const reads = ["r1", "r2", "r3"].map((id) => call(id));
  const text = { type: "text", text: "done reading" };
  const bash = ["b1", "b2", "b3", "b4"].map((id) => call(id, "bash"));
  const all = [...reads, text, ...bash];
  const rs = results(...all.filter((block) => block.type === "toolCall").map((block) => result(block.toolCallId)));
  assert.deepEqual(outline(groupConsecutiveToolCalls(items(...all), rs)), [
    { group: "read", first: 0, count: 3 },
    { block: "text", originalIndex: 3 },
    { group: "bash", first: 4, count: 4 },
  ]);
});

test("the same input groups the same way twice", () => {
  const ids = ["a", "b", "c"];
  const blockItems = items(...ids.map((id) => call(id)));
  const rs = results(...ids.map((id) => result(id)));
  assert.deepEqual(groupConsecutiveToolCalls(blockItems, rs), groupConsecutiveToolCalls(blockItems, rs));
});
