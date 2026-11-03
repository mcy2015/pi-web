"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { openFileTab, saveFileViewerState } from "./file-tab-state";
import {
  FILES_PAGE_TABS_KEY,
  readStoredFilesPageCwd,
  restoreFilesPageTabs,
  saveStoredFilesPageCwd,
} from "./files-page-state";
import { ChangesIcon, EyeIcon, RefreshIcon, SearchIcon, UploadIcon } from "./SidebarIcons";
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
  const [restored, setRestored] = useState(false);
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
    setRestored(true);
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

  const handleViewerStateChange = useCallback((state: FileViewerState) => {
    if (!activeTab) return;
    const revision = activeTab.viewerRevision ?? 0;
    setTabs((prev) => saveFileViewerState(prev, activeTab.id, revision, state));
  }, [activeTab]);

  const handleCloseTab = useCallback((tabId: string) => {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;
    const next = tabs.filter((tab) => tab.id !== tabId);
    setTabs(next);
    // Closing the active tab selects its neighbour, not the far end.
    setActiveTabId((current) => {
      if (current !== tabId) return current;
      return next[Math.min(index, next.length - 1)]?.id ?? null;
    });
  }, [tabs]);

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
                tabs={tabs}
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
            ) : (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
                {t("files.noneOpen")}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
