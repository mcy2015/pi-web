"use client";

// The Usage top panel (AppShell's toolbar): read-only aggregates of the local
// session history (GET /api/usage). Same look and manner as the Debug panel —
// one header row (title, live status, range pills, refresh), one scroll area
// of quiet rows — with the charts from components/usage-charts.tsx.

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatActiveDuration, formatCompactCount, formatCostShort } from "@/lib/session-stats-format";
import { shortenPath } from "@/lib/display-path";
import { USAGE_RANGE_VALUES, type UsageRangeDays, type UsageSnapshot } from "@/lib/usage-types";
import { UsageBarList, UsageHeatmap, UsageTrendChart } from "./usage-charts";

function percentText(ratio: number | null): string {
  return ratio === null ? "—" : `${Math.round(ratio * 100)}%`;
}

function refreshedAtTime(iso: string): string {
  const time = new Date(iso);
  return Number.isFinite(time.getTime())
    ? `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`
    : "";
}

interface Props {
  /** Escape; `restoreFocus`: focus was inside the panel, so it goes back to the Usage button. */
  onClose(restoreFocus: boolean): void;
}

export function UsagePanel({ onClose }: Props) {
  const { t } = useI18n();
  const [range, setRange] = useState<UsageRangeDays>("all");
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async (nextRange: UsageRangeDays, force: boolean) => {
    const id = ++requestId.current;
    if (force) setRefreshing(true);
    setError(false);
    try {
      const params = new URLSearchParams({ range: String(nextRange), ...(force ? { force: "1" } : {}) });
      const res = await fetch(`/api/usage?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as UsageSnapshot;
      if (requestId.current !== id) return;
      setSnapshot(body);
      setLoading(false);
    } catch {
      if (requestId.current !== id) return;
      setError(true);
      setLoading(false);
    } finally {
      if (requestId.current === id) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(range, false);
    return () => {
      requestId.current += 1;
    };
  }, [range, load]);

  // Escape closes the panel, after whatever nearer handler (a menu, ChatInput)
  // took it; focus returns to the Usage button when it was inside the panel.
  useEffect(() => {
    const section = sectionRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      event.preventDefault();
      const active = document.activeElement;
      onClose(Boolean(active instanceof Element && section?.contains(active)));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const isEmpty = snapshot !== null && snapshot.overview.messages === 0 && snapshot.daily.every((day) => day.total === 0);
  const showHeatmap = range !== 7 && snapshot !== null && snapshot.daily.length > 7;
  const status = snapshot
    ? [t("usage.sessions", { sessions: String(snapshot.overview.sessions) }), t("usage.refreshedAt", { time: refreshedAtTime(snapshot.generatedAt) })]
    : [];

  return (
    <section ref={sectionRef} className="usage-panel" aria-label={t("usage.title")}>
      <style>{USAGE_PANEL_CSS}</style>
      <header className="usage-panel-header">
        <span className="usage-panel-heading">{t("usage.title")}</span>
        <span className="usage-panel-status">{status.join(" · ")}</span>
        <span className="usage-panel-range" role="group" aria-label={t("usage.rangeLabel")}>
          {USAGE_RANGE_VALUES.map((value) => (
            <button
              key={String(value)}
              type="button"
              className="usage-pill"
              aria-pressed={range === value}
              onClick={() => setRange(value)}
            >
              {value === "all" ? t("usage.rangeAll") : t(`usage.range${value}`)}
            </button>
          ))}
        </span>
        <button type="button" className="usage-panel-copy" onClick={() => void load(range, true)} disabled={refreshing}>
          {t("usage.refresh")}
        </button>
      </header>
      <div className="usage-panel-scroll">
        {loading && <p className="usage-note">{t("usage.loading")}</p>}
        {!loading && error && (
          <p className="usage-note usage-note-error">
            {t("usage.error")}
            <button type="button" className="usage-panel-copy" onClick={() => void load(range, true)}>{t("usage.retry")}</button>
          </p>
        )}
        {!loading && !error && isEmpty && <p className="usage-note">{t("usage.empty")}</p>}
        {!loading && !error && snapshot !== null && !isEmpty && (
          <>
            <div className="usage-stats">
              <span className="usage-stat">
                <strong className="usage-stat-value">{formatCompactCount(snapshot.overview.tokens.total)}</strong>
                <span className="usage-stat-label">{t("usage.totalTokens")}</span>
              </span>
              <span className="usage-stat">
                <strong className="usage-stat-value">{formatCostShort(snapshot.overview.cost) ?? "$0"}</strong>
                <span className="usage-stat-label">{t("usage.cost")}</span>
              </span>
              <span className="usage-stat">
                <strong className="usage-stat-value">{formatCompactCount(snapshot.overview.sessions)}</strong>
                <span className="usage-stat-label">{t("usage.sessionsCount")}</span>
              </span>
              <span className="usage-stat">
                <strong className="usage-stat-value">{formatCompactCount(snapshot.overview.messages)}</strong>
                <span className="usage-stat-label">{t("usage.messages")}</span>
              </span>
              <span className="usage-stat">
                <strong className="usage-stat-value">{snapshot.overview.activeDays}</strong>
                <span className="usage-stat-label">{t("usage.activeDays")}</span>
              </span>
              <span className="usage-stat">
                <strong className="usage-stat-value">{formatActiveDuration(snapshot.overview.totalActiveMs)}</strong>
                <span className="usage-stat-label">{t("usage.activeTime")}</span>
              </span>
              <span className="usage-stat">
                <strong className="usage-stat-value usage-stat-model" title={snapshot.overview.topModel?.model ?? undefined}>
                  {snapshot.overview.topModel ? snapshot.overview.topModel.model : "—"}
                </strong>
                <span className="usage-stat-label">
                  {snapshot.overview.topModel ? `${t("usage.topModel")} · ${percentText(snapshot.overview.topModel.share)}` : t("usage.topModel")}
                </span>
              </span>
            </div>

            <p className="usage-inline">
              {`${t("usage.currentStreak")} ${snapshot.activity.currentStreakDays} ${t("usage.daysUnit")} · ${t("usage.longestStreak")} ${snapshot.activity.longestStreakDays} ${t("usage.daysUnit")} · ${t("usage.cacheHitRate")} ${percentText(snapshot.activity.cacheHitRate)}`}
              {snapshot.activity.peakHour !== null ? ` · ${t("usage.peakHour")} ${snapshot.activity.peakHour}:00–${snapshot.activity.peakHour}:59` : ""}
            </p>

            <div className="usage-section">
              <div className="usage-section-title">{t("usage.dailyTrend")}</div>
              <UsageTrendChart daily={snapshot.daily} formatCount={formatCompactCount} title={t("usage.dailyTrend")} />
              {showHeatmap && <UsageHeatmap daily={snapshot.daily} formatCount={formatCompactCount} />}
            </div>

            {snapshot.models.length > 0 && (
              <div className="usage-section">
                <div className="usage-section-title">{t("usage.models")}</div>
                <UsageBarList
                  items={snapshot.models.map((row) => ({
                    key: row.model,
                    label: row.model === "unknown" ? t("usage.unknownModel") : row.model,
                    value: row.total,
                    hint: formatCostShort(row.cost) ?? undefined,
                  }))}
                  formatValue={formatCompactCount}
                />
              </div>
            )}

            {snapshot.tools.length > 0 && (
              <div className="usage-section">
                <div className="usage-section-title">{t("usage.tools")}</div>
                <UsageBarList
                  items={snapshot.tools.map((row) => ({ key: row.name, label: row.name, value: row.count }))}
                  formatValue={(count) => `${formatCompactCount(count)} ${t("usage.timesUnit")}`}
                />
              </div>
            )}

            {snapshot.projects.length > 0 && (
              <div className="usage-section">
                <div className="usage-section-title">{t("usage.projects")}</div>
                <UsageBarList
                  items={snapshot.projects.map((row) => ({
                    key: row.cwd,
                    label: shortenPath(row.cwd),
                    value: row.total,
                    hint: `${row.sessions} ${t("usage.sessionsCount").toLowerCase()}`,
                  }))}
                  formatValue={formatCompactCount}
                />
              </div>
            )}

            <p className="usage-footnote">{t("usage.subagentsIncluded")}</p>
          </>
        )}
      </div>
    </section>
  );
}

// The Debug panel's look, token for token: the panel's background, a border
// below, quiet 12px rows, 11px section titles, tabular numbers, no cards.
const USAGE_PANEL_CSS = `
  .usage-panel {
    display: flex;
    max-height: min(720px, 80dvh);
    flex-direction: column;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    box-shadow: 0 10px 28px rgba(0,0,0,0.10);
    color: var(--text);
  }
  .usage-panel-header {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 12px;
    min-width: 0;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  .usage-panel-heading {
    flex-shrink: 0;
    color: var(--text);
    font-weight: 700;
  }
  .usage-panel-status {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 6px;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .usage-panel-range {
    display: inline-flex;
    flex-shrink: 0;
    margin-left: auto;
    gap: 4px;
  }
  .usage-pill {
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .usage-pill:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .usage-pill[aria-pressed="true"] {
    background: var(--bg-selected);
    border-color: var(--accent);
    color: var(--text);
  }
  .usage-panel-copy {
    flex-shrink: 0;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 11px;
  }
  .usage-panel-copy:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .usage-panel-copy:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .usage-panel-scroll {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    gap: 10px;
    overflow: auto;
    padding: 8px 16px 10px;
    font-size: 12px;
    line-height: 1.5;
  }
  .usage-section {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .usage-section-title {
    color: var(--text);
    font-size: 11px;
    font-weight: 700;
  }
  .usage-note {
    margin: 0;
    color: var(--text-dim);
    font-size: 12px;
  }
  .usage-note-error {
    color: var(--text);
  }
  .usage-note .usage-panel-copy {
    margin-left: 8px;
  }
  .usage-stats {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
    gap: 6px 16px;
    padding: 0;
  }
  .usage-stat {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0;
  }
  .usage-stat-value {
    color: var(--text);
    font-size: 16px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .usage-stat-value.usage-stat-model {
    font-size: 12.5px;
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .usage-stat-label {
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.35;
  }
  .usage-inline {
    margin: -4px 0 0;
    color: var(--text-muted);
    font-size: 11.5px;
  }
  .usage-trend {
    position: relative;
    padding-top: 14px;
  }
  .usage-trend-max {
    position: absolute;
    top: 0;
    left: 0;
    color: var(--text-dim);
    font-size: 10px;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
  }
  .usage-trend-svg {
    width: 100%;
    height: 84px;
    display: block;
  }
  .usage-trend-line {
    stroke: var(--accent);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }
  .usage-trend-area {
    fill: var(--accent);
    opacity: 0.12;
  }
  .usage-trend-labels {
    position: relative;
    height: 14px;
  }
  .usage-trend-label {
    position: absolute;
    top: 2px;
    color: var(--text-dim);
    font-size: 10px;
    line-height: 1.2;
    white-space: nowrap;
  }
  .usage-heatmap {
    display: grid;
    gap: 1px;
    height: 13px;
    width: 100%;
  }
  .usage-heat-cell {
    min-width: 0;
    border-radius: 2px;
    background: var(--bg-hover);
  }
  .usage-heat-cell[data-level="1"] { background: color-mix(in srgb, var(--accent) 20%, var(--bg-panel)); }
  .usage-heat-cell[data-level="2"] { background: color-mix(in srgb, var(--accent) 40%, var(--bg-panel)); }
  .usage-heat-cell[data-level="3"] { background: color-mix(in srgb, var(--accent) 65%, var(--bg-panel)); }
  .usage-heat-cell[data-level="4"] { background: color-mix(in srgb, var(--accent) 90%, var(--bg-panel)); }
  .usage-bar-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .usage-bar-row {
    display: grid;
    grid-template-columns: minmax(110px, 240px) 1fr auto;
    align-items: center;
    gap: 10px;
    padding: 1px 2px;
    border-radius: 4px;
    font-size: 12px;
  }
  .usage-bar-row:hover {
    background: var(--bg-hover);
  }
  .usage-bar-label {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .usage-bar-track {
    height: 4px;
    border-radius: 2px;
    background: var(--bg-hover);
    overflow: hidden;
  }
  .usage-bar-fill {
    display: block;
    height: 100%;
    border-radius: 2px;
    background: var(--accent);
  }
  .usage-bar-value {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .usage-footnote {
    margin: 0;
    color: var(--text-dim);
    font-size: 11px;
  }
`;
