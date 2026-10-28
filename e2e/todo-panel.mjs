// The todo panel above the composer: a read-only projection of the newest
// todo snapshot in the loaded conversation. The fixture session carries the
// retired rpiv-todo plugin's per-item `todo` result first (the legacy
// fallback must not win), then two TodoWrite snapshots — the second (2/3
// completed) must beat the first (1/3).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const FIRST_TODOS = [
  { content: "E2E todo draft outline", status: "completed", priority: "medium" },
  { content: "E2E todo high step", status: "in_progress", priority: "high" },
  { content: "E2E todo final review", status: "pending", priority: "low" },
];
const SECOND_TODOS = [
  { content: "E2E todo draft outline", status: "completed", priority: "medium" },
  { content: "E2E todo high step", status: "completed", priority: "high" },
  { content: "E2E todo final review", status: "pending", priority: "low" },
];

const todoDetails = (todos) => {
  const counts = { total: todos.length, pending: 0, inProgress: 0, completed: 0 };
  for (const todo of todos) {
    if (todo.status === "pending") counts.pending++;
    else if (todo.status === "in_progress") counts.inProgress++;
    else counts.completed++;
  }
  return { kind: "pi-web-todo", todos, counts };
};

/** Seed before the server starts: one session whose todo history ends at the second snapshot. */
export function createTodoPanelFixtures({ sessionDir, project, timestamp }) {
  const id = "e2e-todo-panel";
  const message = (entryId, parentId, role, content) => ({
    type: "message", id: entryId, parentId, timestamp, message: { role, content },
  });
  const call = (entryId, parentId, toolCallId, name, arguments_) => ({
    ...message(entryId, parentId, "assistant", [{ type: "toolCall", id: toolCallId, name, arguments: arguments_ }]),
  });
  const result = (entryId, parentId, toolCallId, name, details) => {
    const entry = message(entryId, parentId, "toolResult", [{ type: "text", text: `E2E ${name} output` }]);
    Object.assign(entry.message, { toolCallId, toolName: name, isError: false, details });
    return entry;
  };
  const entries = [
    message("user", null, "user", "E2E todos please"),
    // The retired plugin's per-item result: older, and never the winner.
    call("legacy-call", "user", "lt1", "todo", { action: "write", subject: "E2E legacy todo subject", status: "in_progress" }),
    result("legacy-result", "legacy-call", "lt1", "todo", {
      action: "write",
      tasks: [{ id: 1, subject: "E2E legacy todo subject", description: "E2E legacy todo", status: "in_progress", activeForm: "Working on the legacy todo" }],
    }),
    call("write-call-1", "legacy-result", "t1", "TodoWrite", { todos: FIRST_TODOS }),
    result("write-result-1", "write-call-1", "t1", "TodoWrite", todoDetails(FIRST_TODOS)),
    call("write-call-2", "write-result-1", "t2", "TodoWrite", { todos: SECOND_TODOS }),
    result("write-result-2", "write-call-2", "t2", "TodoWrite", todoDetails(SECOND_TODOS)),
    message("answer", "write-result-2", "assistant", [{ type: "text", text: "E2E todos answer" }]),
  ];
  writeFileSync(join(sessionDir, `2026-08-23T00-00-00-000Z_${id}.jsonl`),
    [{ type: "session", version: 3, id, timestamp, cwd: project }, ...entries]
      .map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { id };
}

export async function checkTodoPanel({ browser, base, artifacts, session }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    await page.goto(`${base}/?session=${session}`, { waitUntil: "domcontentloaded" });
    await page.getByText("E2E todos answer", { exact: true }).first().waitFor({ state: "visible" });

    // Collapsed by default, with the newest snapshot's counts: 2/3 done and
    // the one pending item — not the first write's 1/3 (whose summary would
    // name its in-progress item) and not the legacy list's 0/1.
    const toggle = page.getByRole("button", { name: "Todos 2/3 · 1 remaining", exact: true });
    await toggle.waitFor({ state: "visible" });
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    const list = toggle.locator("xpath=following-sibling::ul");
    assert.equal(await list.count(), 0, "The folded panel must not render the list");

    // Expanded: the status glyphs, the contents (struck through when done),
    // and the high-priority badge — with no legacy item among them.
    await toggle.click();
    await list.waitFor({ state: "visible" });
    const items = list.locator("li");
    assert.equal(await items.count(), 3);
    assert.deepEqual(await items.locator("span[aria-hidden='true']").allTextContents(), ["✓", "✓", "○"]);
    assert.deepEqual(await items.locator("span:nth-of-type(2)").allTextContents(),
      ["E2E todo draft outline", "E2E todo high step", "E2E todo final review"]);
    assert.equal(
      await items.first().locator("span").nth(1).evaluate((element) => element.style.textDecorationLine),
      "line-through",
      "Completed items must be struck through",
    );
    const badge = list.locator("span[title='High priority']");
    assert.equal(await badge.count(), 1);
    assert.equal(await badge.textContent(), "high");
    assert.ok(!(await list.innerText()).includes("E2E legacy todo subject"), "The legacy plugin list must not leak into the panel");
    await page.screenshot({ path: `${artifacts}/todo-panel.png` });

    // The fold choice is remembered per browser, so a reload keeps it open.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("E2E todos answer", { exact: true }).first().waitFor({ state: "visible" });
    await toggle.waitFor({ state: "visible" });
    assert.equal(await toggle.getAttribute("aria-expanded"), "true", "The expanded choice must survive a reload");

    console.log("PASS: todo panel shows the newest snapshot, folds and remembers its expansion");
  } catch (error) {
    await page.screenshot({ path: `${artifacts}/todo-panel-failure.png` }).catch(() => {});
    throw error;
  } finally {
    await context.tracing.stop();
    await context.close();
  }
}
