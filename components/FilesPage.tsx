"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { TerminalPanel } from "./TerminalPanel";
import { openFileTab, saveFileViewerState } from "./file-tab-state";
import {
  FILES_PAGE_TABS_KEY,
  FILES_PAGE_TERMINAL_TABS_KEY,
  readStoredFilesPageCwd,
  restoreFilesPageTabs,
  saveStoredFilesPageCwd,
} from "./files-page-state";
import { newTerminalTab, restoreTerminalTabs, type TerminalTab } from "./terminal-tab-state";
import { ChangesIcon, EyeIcon, RefreshIcon, SearchIcon, TerminalIcon, UploadIcon } from "./SidebarIcons";
import { useI18n } from "@/hooks/useI18n";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import type { FileViewerState } from "@/lib/file-viewer-state";
import { getFileName } from "@/lib/file-paths";

const TREE_MIN_WIDTH = 180;
const TREE_DEFAULT_WIDTH = 300;
const TREE_MAX_WIDTH = 640;
const TOP_BAR_HEIGHT = 36;

interface ToolButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  pressed?: boolean;
}

function ToolButton({ label, pressed, children, ...rest }: ToolButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 28, height: 28, padding: 0, flexShrink: 0,
        background: "none", border: "none", borderRadius: 7, cursor: "pointer",
        color: pressed ? "var(--accent)" : "var(--text-muted)",
        transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = "none"; }}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * The /files page: the file panel as a route of its own. The tree is the
 * sidebar's FileExplorer; the viewer side reuses the right panel's tab
 * machinery (TabBar + file-tab-state). Its state is page-local: the cwd in
 * localStorage, the tabs in sessionStorage — nothing is shared with the
 * conversation page.
 */
export function FilesPage() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const urlCwd = searchParams.get("cwd");
  const urlPath = searchParams.get("path");

  const [cwd, setCwd] = useState<string | null>(urlCwd);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [restored, setRestored] = useState(false);
  const [terminalsRestored, setTerminalsRestored] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [changesCount, setChangesCount] = useState(0);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  const treeWidthRef = useRef(TREE_DEFAULT_WIDTH);
  const treeResizer = useResizablePanel({
    ariaLabel: t("files.resizeTree"),
    cssVariable: "--files-page-tree-width",
    defaultWidth: TREE_DEFAULT_WIDTH,
    getMaxWidth: () => Math.max(TREE_MIN_WIDTH + 160, window.innerWidth - 420),
    growthDirection: "right",
    maxWidth: TREE_MAX_WIDTH,
    minWidth: TREE_MIN_WIDTH,
    storageKey: "pi-web:files-page-tree-width",
    widthRef: treeWidthRef,
  });

  // Restore once after mount: the URL's cwd wins over the remembered one, and
  // the URL's path opens (or activates) on top of the restored tabs.
  useEffect(() => {
    const nextCwd = urlCwd ?? readStoredFilesPageCwd();
    if (nextCwd) setCwd(nextCwd);
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(FILES_PAGE_TABS_KEY);
    } catch {
      raw = null;
    }
    const stored = restoreFilesPageTabs(raw);
    if (urlPath && nextCwd) {
      const tabId = `file:${urlPath}`;
      setTabs(openFileTab(stored.tabs, {
        fileName: getFileName(urlPath),
        filePath: urlPath,
        tabId,
      }));
      setActiveTabId(tabId);
    } else {
      setTabs(stored.tabs);
      setActiveTabId(stored.activeTabId);
    }
    try {
      const savedTerminals = restoreTerminalTabs(sessionStorage.getItem(FILES_PAGE_TERMINAL_TABS_KEY));
      setTerminalTabs(savedTerminals.tabs);
      // The terminal store's activeId is the last active tab of either kind;
      // an URL-named file still wins over what the last visit left active.
      if (!urlPath && savedTerminals.activeId) setActiveTabId(savedTerminals.activeId);
    } catch {
      // Storage is optional.
    }
    setRestored(true);
    setTerminalsRestored(true);
    // The URL params are constant for the page's life; restore runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      sessionStorage.setItem(FILES_PAGE_TABS_KEY, JSON.stringify({ tabs, activeId: activeTabId }));
    } catch {
      // The page keeps working without persistence.
    }
  }, [tabs, activeTabId, restored]);

  useEffect(() => {
    if (!terminalsRestored) return;
    try {
      sessionStorage.setItem(FILES_PAGE_TERMINAL_TABS_KEY, JSON.stringify({
        tabs: terminalTabs.map(({ id, cwd }) => ({ id, cwd })),
        activeId: activeTabId,
      }));
    } catch {
      // Storage is optional.
    }
  }, [terminalTabs, activeTabId, terminalsRestored]);

  useEffect(() => {
    if (!restored || !cwd) return;
    saveStoredFilesPageCwd(cwd);
  }, [cwd, restored]);

  const openFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff"; page?: number },
  ) => {
    const tabId = `file:${filePath}`;
    setTabs((prev) => openFileTab(prev, {
      fileName,
      filePath,
      modeHint: options?.modeHint,
      page: options?.page,
      sourceSessionId: null,
      tabId,
    }));
    setActiveTabId(tabId);
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  const panelTabs: Tab[] = [
    ...tabs,
    ...terminalTabs.map((tab) => ({
      id: tab.id,
      label: getFileName(tab.cwd) || tab.cwd,
      filePath: tab.cwd,
      kind: "terminal" as const,
      closing: Boolean(tab.closing),
    })),
  ];

  const openTerminal = useCallback((dir: string) => {
    const existing = terminalTabs.find((tab) => tab.cwd === dir);
    const tab = existing ?? newTerminalTab(dir);
    if (!existing) setTerminalTabs((all) => [...all, tab]);
    setActiveTabId(tab.id);
  }, [terminalTabs]);

  const handleViewerStateChange = useCallback((state: FileViewerState) => {
    if (!activeTab) return;
    const revision = activeTab.viewerRevision ?? 0;
    setTabs((prev) => saveFileViewerState(prev, activeTab.id, revision, state));
  }, [activeTab]);

  const handleCloseTab = useCallback((tabId: string) => {
    if (terminalTabs.some((tab) => tab.id === tabId)) {
      // Marked, not removed: TerminalPanel finishes and reports back onClosed.
      setTerminalTabs((all) => all.map((tab) => tab.id === tabId && !tab.closing ? { ...tab, closing: "close" } : tab));
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;
    const next = tabs.filter((tab) => tab.id !== tabId);
    setTabs(next);
    // Closing the active tab selects its neighbour, not the far end.
    setActiveTabId((current) => {
      if (current !== tabId) return current;
      return next[Math.min(index, next.length - 1)]?.id ?? terminalTabs.at(-1)?.id ?? null;
    });
  }, [tabs, terminalTabs]);

  // TerminalPanel's closing lifecycle: restart swaps the tab, an exit removes it.
  const handleTerminalClosed = useCallback((tab: TerminalTab) => {
    const replacement = tab.closing === "restart" ? newTerminalTab(tab.cwd) : null;
    const remaining = terminalTabs.filter((item) => item.id !== tab.id);
    setTerminalTabs((all) => all.flatMap((item) => item.id !== tab.id ? [item] : replacement ? [replacement] : []));
    setActiveTabId((current) => current !== tab.id ? current : replacement?.id ?? remaining.at(-1)?.id ?? tabs.at(-1)?.id ?? null);
  }, [terminalTabs, tabs]);

  const handleTerminalRestart = useCallback((tabId: string) => {
    setTerminalTabs((all) => all.map((item) => item.id === tabId ? { ...item, closing: "restart" } : item));
  }, []);

  const handleTerminalCloseError = useCallback((tabId: string) => {
    setTerminalTabs((all) => all.map((item) => item.id === tabId ? { ...item, closing: undefined } : item));
  }, []);

  if (!cwd) {
    return (
      <div style={{ height: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 14 }}>{t("files.noProject")}</p>
        <Link
          href="/"
          style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none" }}
        >
          {t("files.backToChat")}
        </Link>
      </div>
    );
  }

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <header
        style={{
          display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
          height: `calc(${TOP_BAR_HEIGHT}px + env(safe-area-inset-top))`,
          padding: "env(safe-area-inset-top) 8px 0 4px",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <Link
          href="/"
          title={t("files.backToChat")}
          aria-label={t("files.backToChat")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 28, height: 28, borderRadius: 7, flexShrink: 0,
            color: "var(--text-muted)", textDecoration: "none", cursor: "pointer",
            fontSize: 15, lineHeight: 1, transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
        >
          ←
        </Link>
        <span
          title={cwd}
          style={{
            flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)",
            padding: "0 6px",
          }}
        >
          {cwd}
        </span>
        <ToolButton
          label={t("terminal.open")}
          onClick={() => openTerminal(cwd)}
        >
          <TerminalIcon size={16} />
        </ToolButton>
        <ToolButton
          label={t("sidebar.searchFiles")}
          pressed={fileSearchOpen}
          aria-controls="file-search-input"
          onClick={() => setFileSearchOpen((open) => !open)}
        >
          <SearchIcon size={16} />
        </ToolButton>
        <ToolButton
          label={t("sidebar.uploadFiles")}
          onClick={() => fileExplorerRef.current?.openUploadPicker()}
        >
          <UploadIcon size={16} />
        </ToolButton>
        <ToolButton
          label={t("sidebar.showIgnoredFiles")}
          pressed={showIgnored}
          onClick={() => setShowIgnored((shown) => !shown)}
        >
          <EyeIcon size={16} />
        </ToolButton>
        <ToolButton
          label={t("sidebar.changedFiles", { count: changesCount })}
          pressed={!changesCollapsed}
          onClick={() => setChangesCollapsed((collapsed) => !collapsed)}
        >
          <ChangesIcon size={16} />
        </ToolButton>
        <ToolButton label={t("sidebar.refresh")} onClick={() => setRefreshKey((key) => key + 1)}>
          <RefreshIcon size={16} />
        </ToolButton>
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div
          ref={treeResizer.panelRef}
          id="files-page-tree"
          className="scrollbar-subtle"
          style={{
            // The hook writes live drag widths to the variable directly on the
            // DOM (no re-render), exactly as AppShell's panels consume theirs.
            "--files-page-tree-width": `${treeResizer.width}px`,
            width: "var(--files-page-tree-width)",
            minWidth: TREE_MIN_WIDTH,
            flexShrink: 0,
            display: "flex", flexDirection: "column",
            overflowY: "auto",
            background: "var(--bg-panel)",
          } as React.CSSProperties}
        >
          <FileExplorer
            ref={fileExplorerRef}
            cwd={cwd}
            onOpenFile={openFile}
            refreshKey={refreshKey}
            changesCollapsed={changesCollapsed}
            onChangesCountChange={setChangesCount}
            fileSearchOpen={fileSearchOpen}
            onFileSearchOpenChange={setFileSearchOpen}
            showHidden={showIgnored}
          />
        </div>
        <div
          {...treeResizer.separatorProps}
          className={`panel-resize-handle${treeResizer.isResizing ? " is-resizing" : ""}`}
          aria-controls="files-page-tree"
          data-resize-handle="files-page-tree"
          title={`${t("files.resizeTree")}: ${t("layout.resizeHint")}`}
        />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
          <div
            style={{
              display: "flex", alignItems: "center", flexShrink: 0,
              height: TOP_BAR_HEIGHT,
              paddingLeft: 8,
              background: "var(--bg-panel)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <div style={{ flex: 1, overflow: "hidden" }}>
              <TabBar
                tabs={panelTabs}
                activeTabId={activeTabId ?? ""}
                onSelectTab={setActiveTabId}
                onCloseTab={handleCloseTab}
              />
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
            {activeTab ? (
              <FileViewer
                key={`${activeTab.id}:${activeTab.viewerRevision ?? 0}`}
                filePath={activeTab.filePath}
                cwd={cwd}
                gitRefreshKey={refreshKey}
                initialDisplayMode={activeTab.initialDisplayMode}
                initialPage={activeTab.page}
                initialState={activeTab.viewerState}
                watchEnabled
                onStateChange={handleViewerStateChange}
                onOpenFile={(filePath, page) => openFile(filePath, getFileName(filePath), { page })}
              />
            ) : !terminalTabs.some((tab) => tab.id === activeTabId) ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
                {t("files.noneOpen")}
              </div>
            ) : null}
            {terminalTabs.map((tab) => (
              <div key={tab.id} hidden={tab.id !== activeTabId} style={{ width: "100%", height: "100%" }}>
                <TerminalPanel
                  tab={tab}
                  active={tab.id === activeTabId}
                  onRestart={() => handleTerminalRestart(tab.id)}
                  onClosed={() => handleTerminalClosed(tab)}
                  onCloseError={() => handleTerminalCloseError(tab.id)}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
