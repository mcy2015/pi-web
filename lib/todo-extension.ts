import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionFactory,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

// Pi Web's own todo list for the model, with ZCode-style snapshot semantics: TodoWrite replaces
// the whole list, TodoRead reports it unchanged. It stands in for the user's @juicesharp/rpiv-todo
// plugin in web sessions (preferPiWebTodoExtension below suppresses the plugin and its per-item
// `todo` tool), and every result carries a `details` envelope the chat's todo panel renders.

/** The npm plugin this built-in replaces; suppressed in web sessions by preferPiWebTodoExtension(). */
const TODO_PLUGIN_PACKAGE = "@juicesharp/rpiv-todo";
const TODO_PLUGIN_PATH_SEGMENT = "rpiv-todo";
const TODO_WRITE_TOOL = "TodoWrite";
const TODO_READ_TOOL = "TodoRead";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

export interface TodoDetails {
  kind: "pi-web-todo";
  todos: TodoItem[];
  counts: { total: number; pending: number; inProgress: number; completed: number };
}

/**
 * True when a tool result's `details` carry this extension's todo list. Structural, like
 * isSubagentToolDetails(), so the client can adopt the check without pulling this server-side
 * module into a browser bundle.
 */
export function isTodoDetails(value: unknown): value is TodoDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<TodoDetails>;
  if (details.kind !== "pi-web-todo" || !Array.isArray(details.todos)) return false;
  const counts = details.counts as Partial<TodoDetails["counts"]> | undefined;
  if (!counts) return false;
  return [counts.total, counts.pending, counts.inProgress, counts.completed]
    .every((count) => typeof count === "number");
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

/**
 * The live list per session id, partitioned like rpiv-todo's store so a detached or child session
 * (distinct id) can never read or clobber another session's list. Entries are not evicted: the
 * extension runtime's `session_shutdown` carries no session id, and a web server process holds a
 * bounded set of sessions, so the Map stays bounded by them (one small array each).
 */
const sessions = new Map<string, TodoItem[]>();

/** Session-id extractor, as rpiv-todo's `sid()` takes it: `?? ""` keeps the key a plain string. */
function sid(ctx: { sessionManager: { getSessionId(): string } }): string {
  return ctx.sessionManager.getSessionId() ?? "";
}

/**
 * Replay seam: walk the branch in chronological order and let the LAST TodoWrite/TodoRead result
 * whose `details` pass isTodoDetails win (last-write-wins), as rpiv-todo replays its `todo`
 * results. Only this extension's own envelope is recognized; the plugin's per-item `TaskDetails`
 * is deliberately not parsed — a different data model, from an extension web sessions suppress.
 */
function replayTodos(branch: readonly unknown[]): TodoItem[] {
  let todos: TodoItem[] = [];
  for (const entry of branch) {
    const record = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
    if (record.type !== "message") continue;
    const message = record.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== TODO_WRITE_TOOL && message.toolName !== TODO_READ_TOOL) continue;
    if (!isTodoDetails(message.details)) continue;
    todos = message.details.todos.map((todo) => ({ ...todo }));
  }
  return todos;
}

/**
 * A session's list on first touch: the branch is replayed once, later touches read the Map. A
 * TodoWrite needs no replay — it replaces the whole list, so the replayed value could not survive
 * it — but a TodoRead after a reload or a restart picks the branch's last snapshot back up.
 */
function todosFor(ctx: { sessionManager: { getSessionId(): string; getBranch(): readonly unknown[] } }): TodoItem[] {
  const id = sid(ctx);
  let todos = sessions.get(id);
  if (todos === undefined) {
    todos = replayTodos(ctx.sessionManager.getBranch());
    sessions.set(id, todos);
  }
  return todos;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function countsOf(todos: readonly TodoItem[]): TodoDetails["counts"] {
  const counts = { total: todos.length, pending: 0, inProgress: 0, completed: 0 };
  for (const todo of todos) {
    if (todo.status === "pending") counts.pending++;
    else if (todo.status === "in_progress") counts.inProgress++;
    else counts.completed++;
  }
  return counts;
}

function statusMarker(status: TodoItem["status"]): string {
  return status === "completed" ? "✓" : status === "in_progress" ? "◐" : "○";
}

/** The list as bare transcript text: a header with the counts, then one line per item. */
function listText(intro: string, todos: readonly TodoItem[]): string {
  const counts = countsOf(todos);
  return [
    `${intro} — ${counts.completed}/${counts.total} completed, ${counts.inProgress} in progress:`,
    ...todos.map((todo) => `${statusMarker(todo.status)} ${todo.content}`),
  ].join("\n");
}

/** The `details` envelope; the items are copied so no later caller can alias the stored list. */
function todoDetails(todos: readonly TodoItem[]): TodoDetails {
  return { kind: "pi-web-todo", todos: todos.map((todo) => ({ ...todo })), counts: countsOf(todos) };
}

const TodoItemSchema = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 500, description: "Short imperative task line" }),
  status: StringEnum(["pending", "in_progress", "completed"] as const),
  priority: Type.Optional(StringEnum(["high", "medium", "low"] as const, { description: "Priority level; omit for medium" })),
});

/**
 * The `builtin:todo` extension's code, wrapped by builtin("todo", …) in lib/builtin-extensions.ts
 * as the CLI's built-ins are. Registers the snapshot pair for normal sessions.
 */
export function createTodoExtension(): ExtensionFactory {
  return (pi) => {
    pi.registerTool(defineTool({
      name: TODO_WRITE_TOOL,
      label: "Todo write",
      description: "Write the complete session todo list. Each call replaces the entire list. At most one item may be in_progress. Use it to plan and track multi-step work.",
      promptSnippet: "Track multi-step work with a todo list",
      promptGuidelines: [
        "Use TodoWrite for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
        "TodoWrite replaces the whole list every time: send the complete updated list, not a delta. At most one item may be in_progress at a time.",
        "When starting a task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions.",
        "Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and add a new task for the blocker instead.",
        "Set priority (high/medium/low) when items differ in urgency; omit it for medium.",
        "TodoRead returns the current list without changes; use it after compaction or when unsure of the current state.",
      ],
      parameters: Type.Object({
        todos: Type.Array(TodoItemSchema, {
          maxItems: 50,
          description: "The complete updated todo list. At most one item may be in_progress at a time.",
        }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const inProgress = params.todos.filter((todo) => todo.status === "in_progress");
        if (inProgress.length > 1) {
          const contents = inProgress.map((todo) => `"${todo.content}"`).join(", ");
          return {
            content: [{
              type: "text",
              text: `At most one todo may be in_progress at a time; got ${inProgress.length}: ${contents}. Send the complete list with at most one in_progress.`,
            }],
            details: undefined,
            isError: true,
          };
        }
        const todos: TodoItem[] = params.todos.map((todo) => ({
          content: todo.content,
          status: todo.status,
          priority: todo.priority ?? "medium",
        }));
        sessions.set(sid(ctx), todos);
        return {
          content: [{ type: "text", text: todos.length === 0 ? "Todos cleared." : listText("Todos updated", todos) }],
          details: todoDetails(todos),
        };
      },
    }));

    pi.registerTool(defineTool({
      name: TODO_READ_TOOL,
      label: "Todo read",
      description: "Read the current session todo list without modifying it.",
      promptSnippet: "Track multi-step work with a todo list",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const todos = todosFor(ctx);
        return {
          content: [{ type: "text", text: todos.length === 0 ? "No todos." : listText("Current todos", todos) }],
          details: todoDetails(todos),
        };
      },
    }));
  };
}

// ---------------------------------------------------------------------------
// Plugin suppression
// ---------------------------------------------------------------------------

/**
 * The npm package name of a `sourceInfo.source` pi records as `npm:<name>[@version]`. A scoped
 * package keeps its leading `@`, so a version (when present) starts at the *second* `@`; cutting
 * at the first one — the split preferPiWebSubagentExtension() uses — leaves "" for scoped names.
 */
function npmPackageName(source: string): string {
  const name = source.replace(/^npm:/, "");
  const versionAt = name.indexOf("@", 1);
  return versionAt === -1 ? name : name.slice(0, versionAt);
}

/**
 * Suppress the @juicesharp/rpiv-todo plugin in web sessions: `builtin:todo` replaces its per-item
 * `todo` tool with the TodoWrite/TodoRead snapshot pair. Unconditional — the TUI keeps loading the
 * plugin; only pi-web's extensionsOverride applies this, while the user uninstalls it. Errors on
 * the removed paths go too, and so does a conflict the loader recorded against this built-in for
 * a removed path's tool names, so a stale error cannot name an extension that no longer loads
 * (defensive: the tool names do not collide today).
 */
export function preferPiWebTodoExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const pluginPaths = new Set(base.extensions
    .filter((extension) => {
      if (npmPackageName(extension.sourceInfo?.source ?? "") === TODO_PLUGIN_PACKAGE) return true;
      const pathSegments = extension.path.replaceAll("\\", "/").split("/");
      return pathSegments.some((segment) => segment === TODO_PLUGIN_PATH_SEGMENT);
    })
    .map((extension) => extension.path));
  if (pluginPaths.size === 0) return base;
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !pluginPaths.has(extension.path)),
    errors: base.errors.filter((error) => {
      if (pluginPaths.has(error.path)) return false;
      if (error.path !== "builtin:todo") return true;
      return ![...pluginPaths].some((pluginPath) =>
        error.error === `Tool "${TODO_WRITE_TOOL}" conflicts with ${pluginPath}`
        || error.error === `Tool "${TODO_READ_TOOL}" conflicts with ${pluginPath}`
      );
    }),
  };
}
