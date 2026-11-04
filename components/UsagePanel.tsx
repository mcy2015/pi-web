"use client";

// The Usage top panel (AppShell's toolbar), mirroring ZCode's App Usage page:
// a lifetime overview bar (total/peak tokens, longest session, streaks), the
// 52-week token-activity heatmap, then a range-scoped section (last 7/30
// days): the per-model daily trend lines and the model-usage donut. The look
// stays the Debug panel's: one header row, one scroll of quiet rows.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatCompactCount } from "@/lib/session-stats-format";
import { type UsageRangeDays, type UsageSnapshot } from "@/lib/usage-types";
import {
  UsageHeatmap,
  UsageModelDonut,
  UsageTrendChart,
  type HeatmapDay,
  type HeatmapMode,
} from "./usage-charts";

function refreshedAtTime(iso: string): string {
  const time = new Date(iso);
  return Number.isFinite(time.getTime())
    ? `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`
    : "";
}

/** ZCode's wXn: "2 天 3 小时 5 分钟", zero-safe. */
function formatLongDuration(ms: number, parts: { day: string; hour: string; minute: string }): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const out: string[] = [];
  if (days > 0) out.push(`${days} ${parts.day}`);
  if (hours > 0) out.push(`${hours} ${parts.hour}`);
  if (minutes > 0 || out.length === 0) out.push(`${minutes} ${parts.minute}`);
  return out.join(" ");
}

interface Props {
  /** Escape; `restoreFocus`: focus was inside the panel, so it goes back to the Usage button. */
  onClose(restoreFocus: boolean): void;
}

const RANGE_CHOICES: readonly UsageRangeDays[] = [7, 30];

export function UsagePanel({ onClose }: Props) {
  const { t, locale } = useI18n();
  const [range, setRange] = useState<UsageRangeDays>(7);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  // The overview bar and heatmap always read the whole history, like ZCode's
  // separate all-time snapshot, whatever the range below is.
  const [allSnapshot, setAllSnapshot] = useState<UsageSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>("daily");
  const sectionRef = useRef<HTMLElement | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async (nextRange: UsageRangeDays, force: boolean) => {
    const id = ++requestId.current;
    if (force) setRefreshing(true);
    setError(false);
    const params = (which: UsageRangeDays | "all") => new URLSearchParams({ range: String(which), ...(force ? { force: "1" } : {}) });
    try {
      const [rangeRes, allRes] = await Promise.all([
        fetch(`/api/usage?${params(nextRange).toString()}`, { cache: "no-store" }),
        fetch(`/api/usage?${params("all").toString()}`, { cache: "no-store" }),
      ]);
      if (!rangeRes.ok) throw new Error(String(rangeRes.status));
      const body = (await rangeRes.json()) as UsageSnapshot;
      if (requestId.current !== id) return;
      setSnapshot(body);
      if (allRes.ok) setAllSnapshot((await allRes.json()) as UsageSnapshot);
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

  const durationParts = useMemo(() => ({
    day: t("usage.durationDay"),
    hour: t("usage.durationHour"),
    minute: t("usage.durationMinute"),
  }), [t]);

  const heatmapTitleOf = useCallback((day: HeatmapDay, mode: HeatmapMode): string => {
    const tokens = `${formatCompactCount(day.total)} ${t("usage.tokenUnit")}`;
    const messages = t("usage.heatmapMessages", { messages: String(day.messages) });
    if (mode === "weekly") return `${t("usage.heatmapWeekOf", { date: day.date })}\n${tokens} · ${messages}`;
    if (mode === "cumulative") return `${t("usage.heatmapThrough", { date: day.date })}\n${tokens} · ${messages}`;
    return `${day.date}\n${tokens} · ${messages}`;
  }, [t]);

  const heatmapMonthLabel = useCallback((dateKey: string) => {
    const [y, m] = dateKey.split("-").map(Number);
    return new Date(y!, m! - 1, 1).toLocaleDateString(locale, { month: "short" });
  }, [locale]);

  const overview = allSnapshot?.overview;
  const overviewBar = overview && allSnapshot
    ? [
      { key: "total", label: t("usage.lifetimeTotalTokens"), value: formatCompactCount(overview.tokens.total) },
      { key: "peak", label: t("usage.peakDayTokens"), value: formatCompactCount(overview.peakDayTokens) },
      { key: "longest", label: t("usage.longestSession"), value: formatLongDuration(overview.longestSessionActiveMs, durationParts) },
      {
        key: "current",
        label: t("usage.currentStreak"),
        value: t("usage.streakDays", { days: String(allSnapshot.activity.currentStreakDays) }),
      },
      {
        key: "maxstreak",
        label: t("usage.longestStreak"),
        value: t("usage.streakDays", { days: String(allSnapshot.activity.longestStreakDays) }),
      },
    ]
    : [];
  const trendModels = useMemo(() => snapshot?.models.slice(0, 6).map((row) => row.model) ?? [], [snapshot]);
  const donutModels = snapshot?.models ?? [];
  const hasTrendData = snapshot !== null && snapshot.daily.some((day) => day.total > 0);

  return (
    <section ref={sectionRef} className="usage-panel" aria-label={t("usage.title")}>
      <style>{USAGE_PANEL_CSS}</style>
      <header className="usage-panel-header">
        <span className="usage-panel-heading">{t("usage.title")}</span>
        <span className="usage-panel-status">
          {allSnapshot
            ? [
              t("usage.sessions", { sessions: String(allSnapshot.overview.sessions) }),
              t("usage.refreshedAt", { time: refreshedAtTime(allSnapshot.generatedAt) }),
            ].join(" · ")
            : ""}
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
        {!loading && !error && (
          <>
            {overview && (
              <div className="usage-overview" role="list">
                {overviewBar.map((item, index) => (
                  <div key={item.key} className="usage-overview-item" role="listitem">
                    {index > 0 && <span className="usage-overview-divider" aria-hidden="true" />}
                    <span className="usage-overview-value">{item.value}</span>
                    <span className="usage-overview-label">{item.label}</span>
                  </div>
                ))}
              </div>
            )}

            {allSnapshot !== null && allSnapshot.daily.some((day) => day.total > 0) && (
              <div className="usage-section">
                <div className="usage-heatmap-head">
                  <div className="usage-section-title">{t("usage.heatmapTitle")}</div>
                  <span className="usage-panel-range" role="group" aria-label={t("usage.heatmapModeLabel")}>
                    {(["daily", "weekly", "cumulative"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className="usage-pill"
                        aria-pressed={heatmapMode === mode}
                        onClick={() => setHeatmapMode(mode)}
                      >
                        {t(`usage.heatmapRange.${mode}`)}
                      </button>
                    ))}
                  </span>
                </div>
                <UsageHeatmap
                  daily={allSnapshot.daily}
                  mode={heatmapMode}
                  titleOf={heatmapTitleOf}
                  labelOfMonth={heatmapMonthLabel}
                />
              </div>
            )}

            <div className="usage-range-row">
              <span className="usage-range-title">{t("usage.rangeTitle")}</span>
              <span className="usage-panel-range" role="group" aria-label={t("usage.rangeTitle")}>
                {RANGE_CHOICES.map((value) => (
                  <button
                    key={String(value)}
                    type="button"
                    className="usage-pill"
                    aria-pressed={range === value}
                    onClick={() => setRange(value)}
                  >
                    {t(`usage.range${value}`)}
                  </button>
                ))}
              </span>
            </div>

            {snapshot !== null && hasTrendData && (
              <div className="usage-section">
                <div className="usage-section-title">{t("usage.dailyTrend")}</div>
                <UsageTrendChart daily={snapshot.daily} models={trendModels} formatCount={formatCompactCount} title={t("usage.dailyTrend")} />
              </div>
            )}

            {snapshot !== null && donutModels.length > 0 && (
              <div className="usage-section">
                <div className="usage-section-title">{t("usage.models")}</div>
                <UsageModelDonut
                  models={donutModels}
                  otherLabel={t("usage.modelOther")}
                  formatCount={formatCompactCount}
                  tokenUnit={t("usage.tokenUnit")}
                />
              </div>
            )}

            {snapshot !== null && !hasTrendData && (
              <p className="usage-note">{t("usage.empty")}</p>
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
// Chart colors are the panel's own variables: muted, theme-safe, six of them.
const USAGE_PANEL_CSS = `
  .usage-panel {
    --usage-c1: #4e9cd4;
    --usage-c2: #57a773;
    --usage-c3: #d09a4e;
    --usage-c4: #9a7fd0;
    --usage-c5: #4eabd0;
    --usage-c6: #d06e9a;
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
    gap: 12px;
    overflow: auto;
    padding: 10px 16px 12px;
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
  .usage-overview {
    display: flex;
    flex-wrap: wrap;
  }
  .usage-overview-item {
    display: flex;
    min-width: 96px;
    flex: 1 1 0;
    flex-direction: column;
    gap: 1px;
    padding: 2px 14px;
  }
  .usage-overview-item:first-child {
    padding-left: 0;
  }
  .usage-overview-divider {
    display: none;
  }
  @media (min-width: 640px) {
    .usage-overview-item {
      border-left: 1px solid var(--border);
    }
    .usage-overview-item:first-child {
      border-left: none;
    }
  }
  .usage-overview-value {
    color: var(--text);
    font-size: 15px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .usage-overview-label {
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.35;
  }
  .usage-range-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .usage-range-title {
    color: var(--text);
    font-size: 12px;
    font-weight: 500;
  }
  .usage-trend {
    position: relative;
    padding-top: 26px;
  }
  .usage-trend-legend {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
  }
  .usage-trend-legend-item {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 5px;
  }
  .usage-trend-legend-dot {
    width: 8px;
    height: 8px;
    flex-shrink: 0;
    border-radius: 2px;
  }
  .usage-trend-legend-label {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 10.5px;
  }
  .usage-trend-max {
    position: absolute;
    top: 30px;
    left: 0;
    color: var(--text-dim);
    font-size: 10px;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
  }
  .usage-trend-svg {
    width: 100%;
    height: 96px;
    display: block;
  }
  .usage-trend-line {
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
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
    display: flex;
    flex-direction: column;
  }
  .usage-heatmap-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .usage-heatmap-grid {
    display: grid;
    grid-template-columns: repeat(78, minmax(0, 1fr));
    column-gap: 2px;
    width: 100%;
  }
  .usage-heatmap-col {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }
  .usage-heat-cell {
    display: block;
    width: 100%;
    aspect-ratio: 1;
    min-width: 0;
    border-radius: 4px;
    border: 1px solid transparent;
    background: var(--bg-hover);
    transition: transform 0.1s;
  }
  .usage-heat-cell[data-has-usage="true"] {
    border-color: var(--border);
  }
  .usage-heat-cell:hover {
    transform: scale(1.15);
    border-color: var(--text-dim);
  }
  .usage-heatmap-col.is-bar:hover .usage-heat-cell {
    border-color: var(--text-dim);
  }
  .usage-heatmap-months {
    display: grid;
    grid-template-columns: repeat(78, minmax(0, 1fr));
    column-gap: 2px;
    margin-top: 5px;
  }
  .usage-heatmap-month {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-dim);
    font-size: 10px;
    line-height: 1.2;
  }
  .usage-heat-cell[data-level="1"] { background: color-mix(in srgb, var(--usage-c1) 30%, var(--bg-panel)); }
  .usage-heat-cell[data-level="2"] { background: color-mix(in srgb, var(--usage-c1) 55%, var(--bg-panel)); }
  .usage-heat-cell[data-level="3"] { background: color-mix(in srgb, var(--usage-c1) 80%, var(--bg-panel)); }
  .usage-heat-cell[data-level="4"] { background: var(--usage-c1); }
  .usage-donut {
    display: flex;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
  }
  .usage-donut-chart {
    position: relative;
    width: 148px;
    height: 148px;
    flex-shrink: 0;
  }
  .usage-donut-svg {
    width: 100%;
    height: 100%;
    display: block;
  }
  .usage-donut-center {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    pointer-events: none;
  }
  .usage-donut-total {
    color: var(--text);
    font-size: 15px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    max-width: 84px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .usage-donut-unit {
    color: var(--text-dim);
    font-size: 10.5px;
  }
  .usage-donut-legend {
    display: flex;
    min-width: 0;
    flex: 1 1 240px;
    flex-direction: column;
  }
  .usage-donut-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: baseline;
    column-gap: 8px;
    padding: 3px 2px;
    border-bottom: 1px solid var(--border);
  }
  .usage-donut-row:last-child {
    border-bottom: none;
  }
  .usage-donut-dot {
    width: 8px;
    height: 8px;
    align-self: center;
    border-radius: 2px;
  }
  .usage-donut-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-size: 12px;
  }
  .usage-donut-share {
    color: var(--text-muted);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }
  .usage-donut-value {
    grid-column: 2 / 4;
    color: var(--text-dim);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
  }
  .usage-footnote {
    margin: 0;
    color: var(--text-dim);
    font-size: 11px;
  }
`;
