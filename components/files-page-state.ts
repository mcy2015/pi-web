import type { Tab } from "./TabBar";
import type { FileViewerDisplayMode, FileViewerState } from "@/lib/file-viewer-state";

/** Where the /files page keeps its cwd (localStorage) and tabs (sessionStorage). */
export const FILES_PAGE_CWD_KEY = "pi-web:files-page-cwd";
export const FILES_PAGE_TABS_KEY = "pi-web:files-page-tabs";
/** Terminal tabs of the /files page: the app's shape, the page's own key. */
export const FILES_PAGE_TERMINAL_TABS_KEY = "pi-web:files-page-terminal-tabs";

const DISPLAY_MODES: readonly string[] = ["source", "preview", "diff"];

function isDisplayMode(value: unknown): value is FileViewerDisplayMode {
  return typeof value === "string" && DISPLAY_MODES.includes(value);
}

function restoreViewerState(raw: unknown): FileViewerState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const state = raw as Record<string, unknown>;
  if (!isDisplayMode(state.displayMode)) return undefined;
  const position = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    displayMode: state.displayMode,
    wrapLines: state.wrapLines === true,
    scrollTop: position(state.scrollTop),
    scrollLeft: position(state.scrollLeft),
  };
}

/**
 * Restore the /files page's tabs. Same discipline as restoreTerminalTabs():
 * every field is checked, malformed entries are dropped (never thrown), and a
 * duplicate id or path keeps only its first occurrence.
 */
export function restoreFilesPageTabs(raw: string | null): { tabs: Tab[]; activeTabId: string | null } {
  try {
    const saved = JSON.parse(raw ?? "null");
    const tabs: Tab[] = [];
    for (const entry of Array.isArray(saved?.tabs) ? saved.tabs : []) {
      if (!entry || typeof entry !== "object") continue;
      const tab = entry as Record<string, unknown>;
      if (typeof tab.id !== "string" || !tab.id
        || typeof tab.label !== "string" || !tab.label
        || typeof tab.filePath !== "string" || !tab.filePath.trim()
        || tabs.some((existing) => existing.id === tab.id || existing.filePath === tab.filePath)) {
        continue;
      }
      tabs.push({
        id: tab.id,
        label: tab.label,
        filePath: tab.filePath,
        sourceSessionId: typeof tab.sourceSessionId === "string" ? tab.sourceSessionId : undefined,
        initialDisplayMode: isDisplayMode(tab.initialDisplayMode) ? tab.initialDisplayMode : undefined,
        page: typeof tab.page === "number" && Number.isFinite(tab.page) && tab.page > 0 ? tab.page : undefined,
        viewerState: restoreViewerState(tab.viewerState),
        // A restored tab mounts fresh; the revision counts later in-page updates.
        viewerRevision: 0,
      });
    }
    return {
      tabs,
      activeTabId: tabs.some((tab) => tab.id === saved.activeId) ? saved.activeId : null,
    };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

export function readStoredFilesPageCwd(): string | null {
  try {
    const stored = window.localStorage.getItem(FILES_PAGE_CWD_KEY);
    return stored && stored.trim() ? stored : null;
  } catch {
    return null;
  }
}

export function saveStoredFilesPageCwd(cwd: string): void {
  try {
    window.localStorage.setItem(FILES_PAGE_CWD_KEY, cwd);
  } catch {
    // The page keeps working without persistence.
  }
}
