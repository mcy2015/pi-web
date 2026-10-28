# Built-in todo list

The session's todo list is Pi Web's own `builtin:todo` extension plus a native panel — a web-session counterpart of the @juicesharp/rpiv-todo npm plugin, with ZCode-style snapshot semantics. It is a fork feature (upstream keeps such things in extensions); the plugin keeps working unchanged in the TUI.

## The extension (`lib/todo-extension.ts`)

- `createTodoExtension()` is an `ExtensionFactory` wrapped by `builtin("todo", …)` in `createPiWebBuiltinExtensions()`, so `-builtin:todo` in the settings' `extensions` list switches it off, and it loads for normal sessions only: chat-only sessions load no built-ins, and subagents load only what their profile turns on (`createMcpBuiltins` is untouched).
- Two tools, snapshot semantics: `TodoWrite` replaces the whole list (≤ 50 items, content 1–500 chars), `TodoRead` reports it without changes. More than one `in_progress` item is rejected with a teaching error that names the offenders; a missing `priority` is stored as `medium`. The description, prompt snippet and guidelines are the contract the model learns — edit them as carefully as code.
- State is a module-level `Map<sessionId, TodoItem[]>`, partitioned the way rpiv-todo's store is, so a detached or child session cannot read or clobber another's list. Nothing evicts entries (`session_shutdown` carries no session id); the Map is bounded by the process's sessions. On first read (a `TodoRead` after a reload or restart) the branch is replayed and the LAST `TodoWrite`/`TodoRead` result whose `details` pass `isTodoDetails` wins; a write needs no replay since it replaces the list anyway. Only the built-in envelope is recognized — the plugin's per-item `TaskDetails` is deliberately not parsed server-side.
- Every result carries the `details` envelope `{kind:"pi-web-todo", todos, counts}` with copies, never aliases, of the stored list; failed writes return `details: undefined`, which replay skips. The envelope is the persistence: the transcript is the store. If compaction ever drops the last todo result, the panel falls back to the older snapshot it still holds (the same exposure rpiv-todo had); a fresh write re-establishes the list.

## Plugin suppression

- `preferPiWebTodoExtension()` runs first in `lib/rpc-manager.ts`'s `extensionsOverride` chain and drops every extension of the npm package `@juicesharp/rpiv-todo` (or a `rpiv-todo` path segment) from web sessions, together with errors on those paths and a conflict the loader recorded against `builtin:todo` for their tool names (defensive: the tool names do not collide). Unconditional while the plugin is still installed; the TUI loads it as before.
- Scoped-package trap: `npmPackageName()` cuts the version at the *second* `@`, keeping a leading `@` on scoped names. The `split("@")[0]` form `preferPiWebSubagentExtension()` uses returns `""` for scoped packages like this one.

## Client (`lib/todo-state.ts`, `components/TodoPanel.tsx`)

- `deriveTodoState(messages)` scans messages newest→oldest over tool results: a `TodoWrite`/`TodoRead` whose `details` pass the structural `isTodoDetails` wins; a legacy rpiv `todo` result (`details.tasks`) is the fallback, so old transcripts keep their list (`deleted` tombstones skip; `description`/`activeForm` are dropped to keep the item type clean). Malformed `details` never match — the scan continues past them. An `isError` `TodoWrite` carrying a valid envelope still updates the panel: the panel follows the transcript, not the tool call's success.
- The panel is read-only (the model owns the list): hidden while there is no snapshot or an empty one, otherwise a collapsed summary line (`◐ 2/5 · …`) above the composer that expands into the checklist (○ ◐ ✓, completed struck out and muted, `high` priority badged, ◐ gently pulsing with `motion-reduce` respected). The collapsed state persists per browser (`pi-web:todo-panel-collapsed`, `lib/todo-panel-prefs.ts`). The share page's SSR first frame renders collapsed, so a browser that stored "expanded" gets one recoverable hydration notice.
- Mounted in three places: ChatWindow above the composer (live: SSE grows `messages`, the `useMemo` re-derives), SubagentViewer (its context-route pipeline keeps `details`), and SharedSessionView (the share snapshot keeps them too). Subagent sessions do not load the extension — a panel there shows only what a legacy transcript carries.

## Tests

- `lib/todo-extension.test.mjs`: snapshot semantics, the one-in_progress rejection copy, replay, `isTodoDetails`, suppression (scoped source with and without a version, path fallback, unrelated extensions kept, error cleanup).
- `lib/todo-extension.integration.test.mjs`: a real AgentSession writes and reads the list back through the pipeline, and a two-in_progress write fails without landing.
- `lib/todo-state.test.mjs` / `components/TodoPanel.test.mjs`: derivation of both formats and the panel's branches. `e2e/todo-panel.mjs` drives the browsed-session UI against a fixture transcript.
