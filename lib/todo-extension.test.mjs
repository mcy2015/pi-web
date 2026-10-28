import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  createTodoExtension,
  isTodoDetails,
  preferPiWebTodoExtension,
} = await createJiti(import.meta.url).import("./todo-extension.ts");

async function loadTools() {
  const tools = new Map();
  await createTodoExtension()({ registerTool(tool) { tools.set(tool.name, tool); } });
  return tools;
}

function ctx(sessionId, branch = []) {
  return { sessionManager: { getSessionId: () => sessionId, getBranch: () => branch } };
}

function toolResultEntry(toolName, details) {
  return {
    type: "message",
    message: { role: "toolResult", toolCallId: "call", toolName, content: [{ type: "text", text: "recorded" }], details, isError: false },
  };
}

/** The envelope as a replayed branch entry would carry it. */
function envelope(todos) {
  return {
    kind: "pi-web-todo",
    todos: todos.map((todo) => ({ priority: "medium", ...todo })),
    counts: {
      total: todos.length,
      pending: todos.filter((todo) => todo.status === "pending").length,
      inProgress: todos.filter((todo) => todo.status === "in_progress").length,
      completed: todos.filter((todo) => todo.status === "completed").length,
    },
  };
}

test("the extension registers the snapshot pair with the pinned copy and schema bounds", async () => {
  const tools = await loadTools();
  assert.deepEqual([...tools.keys()], ["TodoWrite", "TodoRead"]);

  const write = tools.get("TodoWrite");
  assert.equal(write.description, "Write the complete session todo list. Each call replaces the entire list. At most one item may be in_progress. Use it to plan and track multi-step work.");
  assert.equal(write.promptSnippet, "Track multi-step work with a todo list");
  assert.equal(write.promptGuidelines.length, 6);
  assert.equal(
    write.promptGuidelines[0],
    "Use TodoWrite for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
  );
  assert.equal(write.parameters.properties.todos.maxItems, 50);
  assert.equal(write.parameters.properties.todos.items.properties.content.maxLength, 500);
  assert.deepEqual(write.parameters.properties.todos.items.properties.status.enum, ["pending", "in_progress", "completed"]);
  assert.deepEqual(write.parameters.properties.todos.items.properties.priority.enum, ["high", "medium", "low"]);

  const read = tools.get("TodoRead");
  assert.equal(read.description, "Read the current session todo list without modifying it.");
  assert.equal(read.promptSnippet, "Track multi-step work with a todo list");
});

test("TodoWrite replaces the whole list and defaults priority to medium", async () => {
  const tools = await loadTools();
  const context = ctx("write-snapshot");

  const first = await tools.get("TodoWrite").execute("call", {
    todos: [
      { content: "Read the spec", status: "pending" },
      { content: "Implement the extension", status: "in_progress", priority: "high" },
    ],
  }, undefined, undefined, context);
  assert.equal(first.isError, undefined);
  assert.equal(
    first.content[0].text,
    "Todos updated — 0/2 completed, 1 in progress:\n○ Read the spec\n◐ Implement the extension",
  );
  assert.deepEqual(first.details, {
    kind: "pi-web-todo",
    todos: [
      { content: "Read the spec", status: "pending", priority: "medium" },
      { content: "Implement the extension", status: "in_progress", priority: "high" },
    ],
    counts: { total: 2, pending: 1, inProgress: 1, completed: 0 },
  });

  // A snapshot, not a merge: the second call's list is the whole list.
  const second = await tools.get("TodoWrite").execute("call", {
    todos: [{ content: "Ship it", status: "completed" }],
  }, undefined, undefined, context);
  assert.equal(second.content[0].text, "Todos updated — 1/1 completed, 0 in progress:\n✓ Ship it");
  assert.equal(second.details.todos.length, 1);

  const read = await tools.get("TodoRead").execute("call", {}, undefined, undefined, context);
  assert.equal(read.content[0].text, "Current todos — 1/1 completed, 0 in progress:\n✓ Ship it");
  assert.equal(read.details.counts.total, 1);
});

test("more than one in_progress is refused with the teaching message and keeps the list", async () => {
  const tools = await loadTools();
  const context = ctx("write-validate");

  await tools.get("TodoWrite").execute("call", {
    todos: [{ content: "Read the spec", status: "pending" }],
  }, undefined, undefined, context);

  const refused = await tools.get("TodoWrite").execute("call", {
    todos: [
      { content: "first", status: "in_progress" },
      { content: "second", status: "in_progress" },
    ],
  }, undefined, undefined, context);
  assert.equal(refused.isError, true);
  assert.equal(refused.details, undefined);
  assert.equal(
    refused.content[0].text,
    'At most one todo may be in_progress at a time; got 2: "first", "second". Send the complete list with at most one in_progress.',
  );

  // The refused call changed nothing.
  const read = await tools.get("TodoRead").execute("call", {}, undefined, undefined, context);
  assert.equal(read.content[0].text, "Current todos — 0/1 completed, 0 in progress:\n○ Read the spec");
});

test("an empty list clears the todos", async () => {
  const tools = await loadTools();
  const context = ctx("write-clear");

  await tools.get("TodoWrite").execute("call", {
    todos: [{ content: "Read the spec", status: "completed" }],
  }, undefined, undefined, context);

  const cleared = await tools.get("TodoWrite").execute("call", { todos: [] }, undefined, undefined, context);
  assert.equal(cleared.content[0].text, "Todos cleared.");
  assert.deepEqual(cleared.details, {
    kind: "pi-web-todo",
    todos: [],
    counts: { total: 0, pending: 0, inProgress: 0, completed: 0 },
  });

  const read = await tools.get("TodoRead").execute("call", {}, undefined, undefined, context);
  assert.equal(read.content[0].text, "No todos.");
});

test("the first read replays the branch's last own-format todo result", async () => {
  const tools = await loadTools();
  const earlier = envelope([{ content: "Earlier plan", status: "pending" }]);
  const later = envelope([
    { content: "Later plan", status: "in_progress" },
    { content: "Done already", status: "completed" },
  ]);
  // The plugin's own `todo` results are a different data model and are deliberately not parsed.
  const rpiv = { type: "message", message: { role: "toolResult", toolCallId: "call", toolName: "todo", content: [], details: { action: "create", params: {}, tasks: [{ id: 1, subject: "x", status: "pending" }], nextId: 2 } } };
  const branch = [
    { type: "session", version: 3, id: "s" },
    { type: "message", message: { role: "user", content: "plan" } },
    rpiv,
    toolResultEntry("TodoWrite", earlier),
    toolResultEntry("TodoRead", later),
    toolResultEntry("TodoWrite", { kind: "pi-web-todo", todos: "not an array" }),
  ];

  const read = await tools.get("TodoRead").execute("call", {}, undefined, undefined, ctx("replay", branch));
  assert.equal(read.content[0].text, "Current todos — 1/2 completed, 1 in progress:\n◐ Later plan\n✓ Done already");
  assert.deepEqual(read.details.counts, { total: 2, pending: 0, inProgress: 1, completed: 1 });

  // A session whose branch holds no own-format result starts empty.
  const fresh = await tools.get("TodoRead").execute("call", {}, undefined, undefined, ctx("replay-empty", [rpiv]));
  assert.equal(fresh.content[0].text, "No todos.");
});

test("isTodoDetails accepts only the envelope's shape", () => {
  const valid = envelope([{ content: "task", status: "pending" }]);
  assert.equal(isTodoDetails(valid), true);
  assert.equal(isTodoDetails({ ...valid, kind: "pi-web-subagent" }), false);
  assert.equal(isTodoDetails({ ...valid, todos: "no" }), false);
  assert.equal(isTodoDetails({ ...valid, counts: undefined }), false);
  assert.equal(isTodoDetails({ ...valid, counts: { ...valid.counts, inProgress: "1" } }), false);
  assert.equal(isTodoDetails({ ...valid, counts: { total: 1, pending: 1, inProgress: 1 } }), false);
  assert.equal(isTodoDetails(null), false);
  assert.equal(isTodoDetails("pi-web-todo"), false);
});

test("preferPiWebTodoExtension removes the plugin, its errors, and nothing else", () => {
  const scopedWithVersion = {
    path: "/agent/npm/node_modules/@juicesharp/rpiv-todo/index.ts",
    sourceInfo: { source: "npm:@juicesharp/rpiv-todo@1.2.0" },
    tools: new Map([["todo", {}]]),
  };
  const scopedNoVersion = {
    path: "/agent/npm/node_modules/@other/rpiv-todo/index.ts",
    sourceInfo: { source: "npm:@juicesharp/rpiv-todo" },
    tools: new Map(),
  };
  const pathFallback = {
    path: "/tmp/rpiv-todo/index.ts",
    sourceInfo: { source: "" },
    tools: new Map(),
  };
  const unrelated = {
    path: "/agent/npm/node_modules/pi-subagents/index.ts",
    sourceInfo: { source: "npm:pi-subagents@2.0.0" },
    tools: new Map([["Agent", {}]]),
  };
  const host = {
    path: "builtin:todo",
    sourceInfo: { source: "builtin" },
    tools: new Map([["TodoWrite", {}], ["TodoRead", {}]]),
  };

  const base = {
    extensions: [scopedWithVersion, unrelated, scopedNoVersion, host, pathFallback],
    errors: [
      { path: host.path, error: `Tool "TodoWrite" conflicts with ${scopedWithVersion.path}` },
      { path: pathFallback.path, error: "duplicate tool name" },
      { path: unrelated.path, error: "other" },
    ],
  };
  const result = preferPiWebTodoExtension(base);
  assert.deepEqual(result.extensions.map((extension) => extension.path), [unrelated.path, host.path]);
  assert.deepEqual(result.errors.map((error) => error.path), [unrelated.path]);

  // Nothing to remove: the base result is returned as-is.
  const clean = { extensions: [unrelated, host], errors: [{ path: unrelated.path, error: "other" }] };
  assert.equal(preferPiWebTodoExtension(clean), clean);
});
