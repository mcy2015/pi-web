import assert from "node:assert/strict";
import test from "node:test";

import { restoreFilesPageTabs } from "./files-page-state.ts";

test("restores tabs with their viewer state", () => {
  const raw = JSON.stringify({
    tabs: [
      {
        id: "file:/repo/a.ts",
        label: "a.ts",
        filePath: "/repo/a.ts",
        viewerState: { displayMode: "preview", wrapLines: true, scrollTop: 240, scrollLeft: 16 },
      },
      { id: "file:/repo/b.md", label: "b.md", filePath: "/repo/b.md", page: 3 },
    ],
    activeId: "file:/repo/b.md",
  });
  const { tabs, activeTabId } = restoreFilesPageTabs(raw);
  assert.equal(tabs.length, 2);
  assert.deepEqual(tabs[0].viewerState, {
    displayMode: "preview",
    wrapLines: true,
    scrollTop: 240,
    scrollLeft: 16,
  });
  assert.equal(tabs[0].viewerRevision, 0);
  assert.equal(tabs[1].page, 3);
  assert.equal(activeTabId, "file:/repo/b.md");
});

test("drops malformed entries instead of throwing", () => {
  const raw = JSON.stringify({
    tabs: [
      null,
      "not-an-object",
      { id: "", label: "a", filePath: "/a" },
      { id: "file:/a", label: "", filePath: "/a" },
      { id: "file:/a", label: "a", filePath: "  " },
      { id: "file:/bad", label: "bad", filePath: "/bad", viewerState: { displayMode: "nonsense" } },
      { id: "file:/ok", label: "ok", filePath: "/ok", page: -2 },
    ],
    activeId: "file:/gone",
  });
  const { tabs, activeTabId } = restoreFilesPageTabs(raw);
  // "file:/bad" survives: a broken viewerState is dropped, not the tab.
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].id, "file:/bad");
  assert.equal(tabs[0].viewerState, undefined);
  assert.equal(tabs[1].id, "file:/ok");
  assert.equal(tabs[1].page, undefined);
  assert.equal(tabs[1].viewerState, undefined);
  assert.equal(activeTabId, null);
});

test("keeps only the first of duplicate ids or paths", () => {
  const raw = JSON.stringify({
    tabs: [
      { id: "file:/repo/a.ts", label: "a.ts", filePath: "/repo/a.ts" },
      { id: "file:/repo/a.ts", label: "again", filePath: "/repo/other.ts" },
      { id: "file:/repo/other.ts", label: "other.ts", filePath: "/repo/a.ts" },
    ],
    activeId: null,
  });
  const { tabs } = restoreFilesPageTabs(raw);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].label, "a.ts");
});

test("returns empty state for null, invalid JSON or wrong shapes", () => {
  for (const raw of [null, "", "{oops", '"string"', "42", JSON.stringify({ tabs: "no" })]) {
    assert.deepEqual(restoreFilesPageTabs(raw), { tabs: [], activeTabId: null });
  }
});
