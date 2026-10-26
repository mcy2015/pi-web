"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { layoutGitGraph } from "@/lib/git-graph-layout";
import type { GitGraphCommit, GitGraphRef } from "@/lib/git-types";

const PAGE_SIZE = 50;
/** Load the next page this close to the bottom of the list. */
const LOAD_MORE_THRESHOLD_PX = 96;
const MIN_GRAPH_COLUMN_WIDTH = 56;
/** Six hues that stay readable on light and dark themes alike. */
const LANE_COLORS = ["#4f8cff", "#f59e0b", "#10b981", "#ef4444", "#a855f7", "#d9a814"];

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

interface Props {
  cwd: string;
  /** Bumped by the sidebar's refresh key so the graph follows the files. */
  refreshKey?: number;
}

interface GraphState {
  commits: GitGraphCommit[];
  hasMore: boolean;
}

export function GitGraphPanel({ cwd, refreshKey = 0 }: Props) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<GraphState>({ commits: [], hasMore: false });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [hoveredHash, setHoveredHash] = useState<string | null>(null);
  /** One fetch at a time for the scroll trigger, like a guarded infinite list. */
  const loadingMoreRef = useRef(false);
  const requestIdRef = useRef(0);

  const fetchPage = useCallback(async (skip: number): Promise<GraphState | null> => {
    const params = new URLSearchParams({ cwd, skip: String(skip), maxCount: String(PAGE_SIZE) });
    const requestId = ++requestIdRef.current;
    const response = await fetch(`/api/git/graph?${params.toString()}`);
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }
    const json = await response.json() as GraphState;
    return requestId === requestIdRef.current ? json : null;
  }, [cwd]);

  // The first page, and again whenever the folder or the refresh key changes.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const json = await fetchPage(0);
        if (!cancelled && json) {
          setState(json);
          setSelectedHash(json.commits[0]?.hash ?? null);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [fetchPage, refreshKey]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const json = await fetchPage(0);
      if (json) {
        setState(json);
        setSelectedHash(json.commits[0]?.hash ?? null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  }, [fetchPage]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMoreRef.current || !state.hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const json = await fetchPage(state.commits.length);
      if (json) setState((prev) => ({ commits: [...prev.commits, ...json.commits], hasMore: json.hasMore }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [fetchPage, state.commits.length, state.hasMore]);

  const layout = useMemo(() => layoutGitGraph(state.commits), [state.commits]);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
    [locale],
  );
  const selected = useMemo(
    () => state.commits.find((commit) => commit.hash === selectedHash) ?? null,
    [state.commits, selectedHash],
  );
  const graphColumnWidth = Math.max(layout.width + 12, MIN_GRAPH_COLUMN_WIDTH);
  const gridTemplateColumns = `${graphColumnWidth}px minmax(160px, 1fr) 110px 100px 78px`;

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= LOAD_MORE_THRESHOLD_PX) {
      void handleLoadMore();
    }
  }, [handleLoadMore]);

  if (loading) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
        {t("gitGraph.loading")}
      </div>
    );
  }

  return (
    <section style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)", minWidth: 0 }}>
      <header style={{
        display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
        borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0,
      }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>{t("gitGraph.title")}</span>
        {state.commits.length > 0 && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t(state.hasMore ? "gitGraph.subtitlePartial" : "gitGraph.subtitle", { count: state.commits.length, lanes: layout.laneCount })}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => { void handleRefresh(); }}
          disabled={refreshing}
          title={t("gitGraph.refresh")}
          aria-label={t("gitGraph.refresh")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24,
            border: "none", borderRadius: 4, background: "transparent", color: "var(--text-dim)",
            cursor: "pointer", flexShrink: 0,
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
      </header>

      {error && (
        <div role="alert" style={{ padding: "6px 10px", fontSize: 11, color: "var(--text)", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
          {t("gitGraph.errorLoad", { error })}
        </div>
      )}

      {state.commits.length === 0 ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, color: "var(--text-dim)", padding: 16 }}>
          <span style={{ fontSize: 13 }}>{t("gitGraph.emptyTitle")}</span>
          <span style={{ fontSize: 11 }}>{t("gitGraph.emptyDescription")}</span>
        </div>
      ) : (
        <div
          className="scrollbar-subtle"
          onScroll={handleScroll}
          style={{ flex: 1, minHeight: 0, overflowY: "auto", position: "relative" }}
        >
          {/* Column heads stay above the rows while the list scrolls. */}
          <div style={{
            position: "sticky", top: 0, zIndex: 2, display: "grid", gridTemplateColumns,
            background: "var(--bg-panel)", borderBottom: "1px solid var(--border)",
            fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4,
          }} aria-hidden="true">
            <span />
            <span style={{ padding: "4px 8px", overflow: "hidden", textOverflow: "ellipsis" }}>{t("gitGraph.columnDescription")}</span>
            <span style={{ padding: "4px 8px" }}>{t("gitGraph.columnDate")}</span>
            <span style={{ padding: "4px 8px" }}>{t("gitGraph.columnAuthor")}</span>
            <span style={{ padding: "4px 8px" }}>{t("gitGraph.columnCommit")}</span>
          </div>
          <div style={{ position: "relative" }}>
            <svg
              width={graphColumnWidth}
              height={layout.height + layout.rowHeight}
              viewBox={`0 0 ${graphColumnWidth} ${layout.height + layout.rowHeight}`}
              aria-label={t("gitGraph.graphAriaLabel")}
              role="img"
              style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}
            >
              {layout.paths.map((path) => {
                const related = hoveredHash !== null && path.relatedHashes.includes(hoveredHash);
                const dimmed = hoveredHash !== null && !related;
                return (
                  <path
                    key={path.id}
                    d={path.d}
                    fill="none"
                    stroke={LANE_COLORS[path.colorIndex % LANE_COLORS.length]}
                    strokeWidth={2}
                    opacity={dimmed ? 0.25 : related ? 1 : 0.6}
                  />
                );
              })}
              {layout.rows.map((row) => {
                const isSelected = row.commit.hash === selectedHash;
                const color = LANE_COLORS[row.laneIndex % LANE_COLORS.length];
                return (
                  <g key={row.commit.hash}>
                    <circle cx={row.x} cy={row.y} r={isSelected ? 5 : 4} fill={color} stroke="var(--bg)" strokeWidth={2} />
                    {isSelected && (
                      <circle cx={row.x} cy={row.y} r={7.5} fill="none" stroke={color} strokeWidth={1} opacity={0.85} />
                    )}
                  </g>
                );
              })}
            </svg>
            {layout.rows.map((row) => {
              const commit = row.commit;
              const isSelected = commit.hash === selectedHash;
              return (
                <button
                  key={commit.hash}
                  type="button"
                  onClick={() => { setSelectedHash((current) => current === commit.hash ? null : commit.hash); }}
                  onMouseEnter={() => setHoveredHash(commit.hash)}
                  onMouseLeave={() => setHoveredHash(null)}
                  aria-label={`${shortHash(commit.hash)} ${commit.subject}`}
                  style={{
                    display: "grid", gridTemplateColumns, alignItems: "center", width: "100%",
                    height: layout.rowHeight, textAlign: "left", fontSize: 12,
                    background: isSelected ? "var(--bg-selected)" : "transparent",
                    border: "none", borderTop: isSelected ? "1px solid var(--border)" : "none",
                    borderBottom: isSelected ? "1px solid var(--border)" : "none",
                    cursor: "pointer", padding: 0, color: "var(--text)",
                  }}
                >
                  <span aria-hidden="true" />
                  <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 6, padding: "0 8px" }}>
                    {commit.refs.length > 0 && (
                      <span style={{ display: "inline-flex", gap: 3, flexShrink: 0, maxWidth: 180, overflow: "hidden" }}>
                        {commit.refs.slice(0, 3).map((ref) => (
                          <RefChip key={`${commit.hash}:${ref.kind}:${ref.name}`} gitRef={ref} />
                        ))}
                      </span>
                    )}
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
                      {commit.subject || shortHash(commit.hash)}
                    </span>
                    {commit.parents.length > 1 && (
                      <MergeMark />
                    )}
                  </span>
                  <span style={{ padding: "0 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)", fontSize: 11 }}>
                    {commit.authoredAtMs ? dateFormatter.format(new Date(commit.authoredAtMs)) : ""}
                  </span>
                  <span style={{ padding: "0 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                    {commit.authorName ?? ""}
                  </span>
                  <span style={{ padding: "0 8px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)" }}>
                    {shortHash(commit.hash)}
                  </span>
                </button>
              );
            })}
          </div>
          {state.hasMore && (
            <div style={{ display: "flex", justifyContent: "center", padding: 10 }}>
              <button
                type="button"
                onClick={() => { void handleLoadMore(); }}
                disabled={loadingMore}
                style={{
                  fontSize: 12, padding: "5px 14px", borderRadius: 6, cursor: "pointer",
                  border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)",
                }}
              >
                {loadingMore ? t("gitGraph.loadingMore") : t("gitGraph.loadMore")}
              </button>
            </div>
          )}
        </div>
      )}

      {selected && (
        <footer style={{
          flexShrink: 0, borderTop: "1px solid var(--border)", background: "var(--bg-panel)",
          padding: "8px 10px", display: "grid", gap: 4, fontSize: 11, color: "var(--text-muted)",
          gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)",
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ marginBottom: 2, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-dim)" }}>
              {t("gitGraph.detailSubject")}
            </div>
            <div style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{selected.subject || shortHash(selected.hash)}</div>
            {selected.refs.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                {selected.refs.map((ref) => (
                  <RefChip key={`${selected.hash}:detail:${ref.kind}:${ref.name}`} gitRef={ref} />
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
            <span>
              {t("gitGraph.detailCommit")}: <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{shortHash(selected.hash)}</span>
            </span>
            <span>
              {t("gitGraph.detailAuthor")}: <span style={{ color: "var(--text)" }}>{selected.authorName ?? "—"}</span>
            </span>
            <span>
              {t("gitGraph.detailDate")}:{" "}
              <span style={{ color: "var(--text)" }}>
                {selected.authoredAtMs ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(selected.authoredAtMs)) : "—"}
              </span>
            </span>
            <span style={{ overflowWrap: "anywhere" }}>
              {t("gitGraph.detailParents")}:{" "}
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                {selected.parents.length > 0 ? selected.parents.map(shortHash).join(", ") : "—"}
              </span>
            </span>
          </div>
        </footer>
      )}
    </section>
  );
}

function RefChip({ gitRef }: { gitRef: GitGraphRef }) {
  const isHead = gitRef.kind === "head";
  const isTag = gitRef.kind === "tag";
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", height: 16, padding: "0 5px", borderRadius: 4,
        border: `1px solid ${isHead ? "var(--accent)" : "var(--border)"}`,
        background: isHead ? "var(--bg-selected)" : isTag ? "var(--bg-hover)" : "transparent",
        color: isHead ? "var(--text)" : "var(--text-muted)", fontSize: 10,
        maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {isHead ? "● " : ""}
      {gitRef.name}
    </span>
  );
}

/** A merge commit marker: two dots joined by a curve, as in git UIs. */
function MergeMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--text-dim)" }} aria-hidden="true">
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 9v2a4 4 0 0 0 4 4h5" />
    </svg>
  );
}
