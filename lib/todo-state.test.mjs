// deriveTodoState(): the newest todo snapshot in a conversation. The builtin
// envelope (TodoWrite/TodoRead, kind "pi-web-todo") and the retired rpiv
// plugin's `todo` results are both read, newest first, malformed entries
// skipped in favour of older ones.
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	countTodos,
	deriveTodoState,
	isTodoDetails,
} = await jiti.import("./todo-state.ts");

const user = (text) => ({ role: "user", content: text });
const assistantText = (text) => ({ role: "assistant", content: [{ type: "text", text }], model: "m", provider: "p" });
const toolResult = (toolName, details, extra = {}) => ({
	role: "toolResult",
	toolCallId: "c1",
	toolName,
	content: [{ type: "text", text: "ok" }],
	isError: false,
	details,
	...extra,
});

const builtinDetails = (todos, counts = countTodos(todos)) => ({
	kind: "pi-web-todo",
	todos,
	counts,
});

const builtinTodo = (content, status = "pending", priority) => ({
	content,
	status,
	...(priority ? { priority } : {}),
});

test("isTodoDetails accepts the pinned envelope and rejects malformed ones", () => {
	assert.equal(isTodoDetails(builtinDetails([builtinTodo("a"), builtinTodo("b", "in_progress", "high")])), true);
	assert.equal(isTodoDetails(null), false);
	assert.equal(isTodoDetails({}), false);
	assert.equal(isTodoDetails({ kind: "other", todos: [], counts: { total: 0, pending: 0, inProgress: 0, completed: 0 } }), false);
	assert.equal(isTodoDetails({ kind: "pi-web-todo", todos: "no", counts: { total: 0, pending: 0, inProgress: 0, completed: 0 } }), false);
	assert.equal(isTodoDetails({ kind: "pi-web-todo", todos: [{ content: "a", status: "bogus" }], counts: { total: 1, pending: 1, inProgress: 0, completed: 0 } }), false);
	assert.equal(isTodoDetails({ kind: "pi-web-todo", todos: [{ content: "a", status: "pending", priority: "urgent" }], counts: { total: 1, pending: 1, inProgress: 0, completed: 0 } }), false);
	assert.equal(isTodoDetails({ kind: "pi-web-todo", todos: [], counts: { total: 0, pending: 0, inProgress: 0 } }), false);
});

test("derives the newest builtin snapshot from TodoWrite and TodoRead results", () => {
	const older = builtinDetails([builtinTodo("first", "completed")]);
	const newer = builtinDetails([
		builtinTodo("Read the docs"),
		builtinTodo("Write the panel", "in_progress", "high"),
		builtinTodo("Ship it", "completed"),
	]);
	const messages = [
		user("plan"),
		toolResult("TodoWrite", older),
		assistantText("working"),
		toolResult("TodoRead", newer),
	];
	assert.deepEqual(deriveTodoState(messages), {
		todos: newer.todos,
		counts: { total: 3, pending: 1, inProgress: 1, completed: 1 },
	});
});

test("maps legacy rpiv todo results, skipping deleted tombstones and leaving priority empty", () => {
	const messages = [
		user("plan"),
		toolResult("todo", {
			action: "write",
			params: {},
			tasks: [
				{ id: 1, subject: "Gone", status: "deleted" },
				{ id: 2, subject: "Survey the site", status: "pending" },
				{ id: 3, subject: "Draft the plan", status: "in_progress", activeForm: "Drafting the plan", description: "words" },
				{ id: 4, subject: "Read the brief", status: "completed", blockedBy: 2 },
			],
			nextId: 5,
		}),
		assistantText("done"),
	];
	assert.deepEqual(deriveTodoState(messages), {
		todos: [
			{ content: "Survey the site", status: "pending" },
			{ content: "Draft the plan", status: "in_progress" },
			{ content: "Read the brief", status: "completed" },
		],
		counts: { total: 3, pending: 1, inProgress: 1, completed: 1 },
	});
});

test("newest result wins, whichever format it is", () => {
	const builtin = builtinDetails([builtinTodo("builtin item")]);
	const legacy = {
		action: "write",
		params: {},
		tasks: [{ id: 1, subject: "legacy item", status: "pending" }],
		nextId: 2,
	};

	// The legacy result is newer: the legacy list shows.
	assert.deepEqual(
		deriveTodoState([toolResult("TodoWrite", builtin), toolResult("todo", legacy)]).todos,
		[{ content: "legacy item", status: "pending" }],
	);
	// The builtin result is newer: its envelope shows.
	assert.deepEqual(
		deriveTodoState([toolResult("todo", legacy), toolResult("TodoWrite", builtin)]).todos,
		[{ content: "builtin item", status: "pending" }],
	);
});

test("malformed details are skipped and the scan continues to older results", () => {
	const good = builtinDetails([builtinTodo("older write")]);
	const messages = [
		user("plan"),
		toolResult("TodoWrite", good),
		toolResult("TodoWrite", { kind: "pi-web-todo", todos: [{ content: "x", status: "nope" }], counts: { total: 1, pending: 1, inProgress: 0, completed: 0 } }),
		toolResult("TodoWrite", null),
		toolResult("TodoRead", "not an object"),
	];
	assert.deepEqual(deriveTodoState(messages).todos, [{ content: "older write", status: "pending" }]);

	// A malformed builtin envelope falls back to an older legacy list too.
	const legacy = { tasks: [{ id: 1, subject: "legacy fallback", status: "in_progress" }] };
	assert.deepEqual(
		deriveTodoState([toolResult("todo", legacy), toolResult("TodoWrite", { kind: "pi-web-todo" })]).todos,
		[{ content: "legacy fallback", status: "in_progress" }],
	);

	// The legacy rule itself needs a tasks array.
	assert.equal(deriveTodoState([toolResult("todo", { action: "write", tasks: "no" })]), null);
	assert.equal(deriveTodoState([toolResult("todo", { action: "write" })]), null);
});

test("the envelope is only read from todo tool results, and returns null without any", () => {
	const details = builtinDetails([builtinTodo("item")]);
	assert.equal(deriveTodoState([toolResult("bash", details)]), null);
	// An errored call still carries the snapshot it reports; the spec gates on
	// the envelope alone.
	assert.deepEqual(
		deriveTodoState([toolResult("TodoWrite", details, { isError: true })]).todos,
		[{ content: "item", status: "pending" }],
	);
	assert.equal(deriveTodoState([]), null);
	assert.equal(deriveTodoState([user("hi"), assistantText("hello"), toolResult("read", { path: "a" })]), null);
});
