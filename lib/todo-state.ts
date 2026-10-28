// The session's todo list as the chat sees it: derived from the newest tool
// result that carries one, never fetched or stored on its own. The built-in
// todo extension (`builtin:todo`) attaches a full-snapshot envelope to every
// TodoWrite/TodoRead result; the retired @juicesharp/rpiv-todo plugin's
// `todo` tool is still parsed so old transcripts keep their list. Client-safe:
// structure checks only, no server imports.

import type { AgentMessage } from "./types";

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** Absent on legacy rpiv-todo items; the panel shows no badge without it. */
	priority?: TodoPriority;
}

export interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}

export interface TodoSnapshot {
	todos: TodoItem[];
	counts: TodoCounts;
}

/** The built-in todo extension's `details` envelope: a full snapshot. */
export interface TodoDetails {
	kind: "pi-web-todo";
	todos: TodoItem[];
	counts: TodoCounts;
}

const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];
const TODO_PRIORITIES: readonly TodoPriority[] = ["high", "medium", "low"];

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTodoItem(value: unknown): TodoItem | null {
	if (!isObject(value)) return null;
	if (typeof value.content !== "string") return null;
	if (typeof value.status !== "string" || !TODO_STATUSES.includes(value.status as TodoStatus)) return null;
	const priority = value.priority;
	if (priority !== undefined && priority !== null
		&& (typeof priority !== "string" || !TODO_PRIORITIES.includes(priority as TodoPriority))) {
		return null;
	}
	return {
		content: value.content,
		status: value.status as TodoStatus,
		...(priority === undefined || priority === null ? {} : { priority: priority as TodoPriority }),
	};
}

function readCounts(value: unknown): TodoCounts | null {
	if (!isObject(value)) return null;
	const { total, pending, inProgress, completed } = value;
	if (typeof total !== "number" || !Number.isFinite(total)) return null;
	if (typeof pending !== "number" || !Number.isFinite(pending)) return null;
	if (typeof inProgress !== "number" || !Number.isFinite(inProgress)) return null;
	if (typeof completed !== "number" || !Number.isFinite(completed)) return null;
	return { total, pending, inProgress, completed };
}

/** True when a tool result's `details` carry the built-in todo extension's
 *  snapshot envelope. Structural, like lib/subagent-tool-details.ts, so this
 *  module never pulls the server-side extension into a client bundle. All or
 *  nothing: one malformed entry fails the whole envelope, and the caller
 *  simply keeps scanning older messages. */
export function isTodoDetails(value: unknown): value is TodoDetails {
	if (!isObject(value) || value.kind !== "pi-web-todo") return false;
	if (!Array.isArray(value.todos)) return false;
	for (const item of value.todos) {
		if (readTodoItem(item) === null) return false;
	}
	return readCounts(value.counts) !== null;
}

/** Counts over the items themselves, for snapshots built on the client. */
export function countTodos(todos: readonly TodoItem[]): TodoCounts {
	const counts: TodoCounts = { total: todos.length, pending: 0, inProgress: 0, completed: 0 };
	for (const item of todos) {
		if (item.status === "pending") counts.pending += 1;
		else if (item.status === "in_progress") counts.inProgress += 1;
		else counts.completed += 1;
	}
	return counts;
}

/** The retired @juicesharp/rpiv-todo plugin's `todo` tool results: every call
 *  carried the full task list. `deleted` entries are tombstones and skip;
 *  `description`/`activeForm` are dropped to keep the item type clean — the
 *  panel shows the subject. A task that is not even structurally an item
 *  (no string subject, unknown status) is skipped alone, not the list. */
function legacyTodoSnapshot(details: unknown): TodoSnapshot | null {
	if (!isObject(details) || !Array.isArray(details.tasks)) return null;
	const todos: TodoItem[] = [];
	for (const task of details.tasks) {
		if (!isObject(task)) continue;
		if (task.status === "deleted") continue;
		if (typeof task.subject !== "string") continue;
		if (typeof task.status !== "string" || !TODO_STATUSES.includes(task.status as TodoStatus)) continue;
		todos.push({ content: task.subject, status: task.status as TodoStatus });
	}
	return { todos, counts: countTodos(todos) };
}

/**
 * The newest todo snapshot in the conversation, or null when no tool result
 * carried one. Scans from the newest message backwards over tool results:
 * the built-in envelope wins when the newest matching result has one, the
 * legacy rpiv list when that is the newest, and malformed `details` never
 * match, so the scan simply continues past them to older messages.
 */
export function deriveTodoState(messages: readonly AgentMessage[]): TodoSnapshot | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || message.role !== "toolResult") continue;
		const toolName = message.toolName;
		const details = message.details;
		if ((toolName === "TodoWrite" || toolName === "TodoRead") && isTodoDetails(details)) {
			return {
				// Copies: the snapshot outlives the message object it came from.
				todos: details.todos.map((item) => ({ ...item })),
				counts: { ...details.counts },
			};
		}
		if (toolName === "todo") {
			const snapshot = legacyTodoSnapshot(details);
			if (snapshot) return snapshot;
		}
	}
	return null;
}
