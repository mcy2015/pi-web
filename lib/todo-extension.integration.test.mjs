import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { createTodoExtension } = await createJiti(import.meta.url).import("./todo-extension.ts");

async function createSession(dir, faux, extensionFactories) {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.inMemory(),
    modelRuntime,
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories,
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(dir),
    model: faux.getModel("faux-model"),
  });
  return session;
}

function textOf(message) {
  return message.content.map((block) => block.text ?? "").join("");
}

const TODOS = [
  { content: "Read the spec", status: "pending" },
  { content: "Implement the extension", status: "in_progress", priority: "high" },
  { content: "Run the tests", status: "completed" },
];

test("a session runs TodoWrite and TodoRead with the details envelope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-todo-session-"));
  let session;
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    session = await createSession(dir, faux, [createTodoExtension()]);

    const names = session.getAllTools().map((tool) => tool.name);
    assert.ok(names.includes("TodoWrite"), "TodoWrite should be registered");
    assert.ok(names.includes("TodoRead"), "TodoRead should be registered");
    assert.ok(session.getActiveToolNames().includes("TodoWrite"), "TodoWrite should be active by default");

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("TodoWrite", { todos: TODOS })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("TodoRead", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    await session.prompt("plan the work");

    const write = session.agent.state.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "TodoWrite",
    );
    assert.equal(write.isError, false);
    assert.equal(
      textOf(write),
      "Todos updated — 1/3 completed, 1 in progress:\n○ Read the spec\n◐ Implement the extension\n✓ Run the tests",
    );
    // The envelope the chat's todo panel renders; a missing priority was defaulted to medium.
    assert.deepEqual(write.details, {
      kind: "pi-web-todo",
      todos: [
        { content: "Read the spec", status: "pending", priority: "medium" },
        { content: "Implement the extension", status: "in_progress", priority: "high" },
        { content: "Run the tests", status: "completed", priority: "medium" },
      ],
      counts: { total: 3, pending: 1, inProgress: 1, completed: 1 },
    });

    // A later turn in the same session reads the stored list: the session id keys the state.
    const read = session.agent.state.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "TodoRead",
    );
    assert.equal(read.isError, false);
    assert.equal(
      textOf(read),
      "Current todos — 1/3 completed, 1 in progress:\n○ Read the spec\n◐ Implement the extension\n✓ Run the tests",
    );
    assert.equal(read.details.kind, "pi-web-todo");
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a write with two in_progress items is a teaching error that changes no state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-todo-invalid-"));
  let session;
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    session = await createSession(dir, faux, [createTodoExtension()]);

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("TodoWrite", {
          todos: [
            { content: "first", status: "in_progress" },
            { content: "second", status: "in_progress" },
          ],
        }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("TodoRead", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    await session.prompt("start two things at once");

    const refused = session.agent.state.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "TodoWrite",
    );
    assert.equal(refused.isError, true);
    assert.equal(
      textOf(refused),
      'At most one todo may be in_progress at a time; got 2: "first", "second". Send the complete list with at most one in_progress.',
    );
    assert.equal(refused.details, undefined);

    // The failed write left nothing behind, so the read replays an empty branch.
    const read = session.agent.state.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "TodoRead",
    );
    assert.equal(textOf(read), "No todos.");
    assert.deepEqual(read.details.counts, { total: 0, pending: 0, inProgress: 0, completed: 0 });
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
