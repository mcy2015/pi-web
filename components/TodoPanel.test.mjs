// TodoPanel renders the derived todo snapshot above the composer: hidden with
// nothing to show, a one-line summary folded, the read-only list expanded.
// The fold preference is read at first render, so the expanded branch is
// exercised through a stubbed window.localStorage.
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
	jsx: { runtime: "automatic" },
	tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { TodoPanel } = await jiti.import("./TodoPanel.tsx");
const {
	getTodoPanelCollapsed,
	setTodoPanelCollapsed,
} = await jiti.import("@/lib/todo-panel-prefs");

const snapshot = (todos, counts) => ({ todos, counts: counts ?? {
	total: todos.length,
	pending: todos.filter((t) => t.status === "pending").length,
	inProgress: todos.filter((t) => t.status === "in_progress").length,
	completed: todos.filter((t) => t.status === "completed").length,
} });

function renderPanel(props) {
	return renderToStaticMarkup(React.createElement(TodoPanel, props));
}

/** Renders with the fold preference answered by a stubbed localStorage. */
function renderPanelWithStorage(storedValue, props) {
	const originalWindow = globalThis.window;
	globalThis.window = { localStorage: { getItem: () => storedValue, setItem() {} } };
	try {
		return renderPanel(props);
	} finally {
		if (originalWindow === undefined) delete globalThis.window;
		else globalThis.window = originalWindow;
	}
}

test("renders nothing without a snapshot or with an empty list", () => {
	assert.equal(renderPanel({ snapshot: null }), "");
	assert.equal(renderPanel({ snapshot: snapshot([]) }), "");
});

test("folded by default: done/total, the in-progress item and a closed chevron", () => {
	const html = renderPanel({ snapshot: snapshot([
		{ content: "Read the docs", status: "completed" },
		{ content: "Write the panel", status: "in_progress", priority: "high" },
		{ content: "Ship it", status: "pending" },
	]) });

	assert.match(html, /aria-expanded="false"/);
	assert.match(html, /◐/);
	assert.match(html, /1\/3/);
	assert.match(html, /Write the panel/);
	// The folded bar never shows the list itself.
	assert.doesNotMatch(html, /Read the docs/);
	assert.doesNotMatch(html, /<ul/);
});

test("folded without an in-progress item: pending count, or all done", () => {
	const pending = renderPanel({ snapshot: snapshot([
		{ content: "Read the docs", status: "completed" },
		{ content: "Ship it", status: "pending" },
	]) });
	assert.match(pending, /○/);
	assert.match(pending, /1\/2/);
	assert.match(pending, /1 remaining/);

	const done = renderPanel({ snapshot: snapshot([
		{ content: "Read the docs", status: "completed" },
	]) });
	assert.match(done, /✓/);
	assert.match(done, /1\/1/);
	assert.match(done, /All done/);
});

test("expanded: statuses, strikethrough on completed and the high-priority badge", () => {
	const html = renderPanelWithStorage("false", { snapshot: snapshot([
		{ content: "Read the docs", status: "completed" },
		{ content: "Write the panel", status: "in_progress", priority: "high" },
		{ content: "Ship it", status: "pending" },
	]) });

	assert.match(html, /aria-expanded="true"/);
	assert.match(html, /<ul/);
	// The summary glyph reflects the whole list (in progress here), so the
	// item glyphs add one of each on top of it.
	assert.equal((html.match(/◐/g) ?? []).length, 2);
	assert.equal((html.match(/✓/g) ?? []).length, 1);
	assert.equal((html.match(/○/g) ?? []).length, 1);
	assert.match(html, /text-decoration:line-through/);
	assert.match(html, />Read the docs</);
	assert.match(html, /Write the panel/);
	// The high-priority badge: accent-toned, on its item only.
	assert.equal((html.match(/>high</g) ?? []).length, 1);
	assert.match(html, /border:1px solid var\(--accent\)/);
});

test("the fold preference round-trips and defaults to collapsed", () => {
	const values = new Map();
	const storage = {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
	};

	assert.equal(getTodoPanelCollapsed(storage), true);
	setTodoPanelCollapsed(false, storage);
	assert.equal(values.get("pi-web:todo-panel-collapsed"), "false");
	assert.equal(getTodoPanelCollapsed(storage), false);
	setTodoPanelCollapsed(true, storage);
	assert.equal(getTodoPanelCollapsed(storage), true);
	// Anything unreadable stays collapsed.
	assert.equal(getTodoPanelCollapsed({ getItem: () => "bogus", setItem() {} }), true);
});
