// Pure-presentational charts of the Usage top panel (components/UsagePanel.tsx).
// No i18n and no state here: labels and formatted values arrive as props, and
// every chart is decorative (aria-hidden) with the readable detail in the
// neighboring lists or in each cell's title.

import type { UsageDailyRow } from "@/lib/usage-types";

// ---------------------------------------------------------------------------
// Trend chart (SVG lines stretched to the panel width, HTML labels on top)
// ---------------------------------------------------------------------------

export interface TrendPoint {
  x: number;
  y: number;
}

/** Map daily totals into viewBox coordinates. Exported for tests. */
export function trendPoints(daily: readonly UsageDailyRow[], width: number, height: number, padding = 8): TrendPoint[] {
  if (daily.length === 0) return [];
  const max = Math.max(...daily.map((day) => day.total), 1);
  const span = width - padding * 2;
  const step = daily.length > 1 ? span / (daily.length - 1) : 0;
  return daily.map((day, index) => ({
    x: padding + step * index,
    y: height - padding - (day.total / max) * (height - padding * 2),
  }));
}

/** Up to `maxLabels} X-axis labels spread over the days. Exported for tests. */
export function trendLabelIndexes(count: number, maxLabels = 5): number[] {
  if (count <= 0) return [];
  if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
  const indexes = new Set<number>([0, count - 1]);
  for (let i = 1; i < maxLabels - 1; i++) indexes.add(Math.round((i * (count - 1)) / (maxLabels - 1)));
  return [...indexes].sort((a, b) => a - b);
}

const TREND_W = 720;
const TREND_H = 84;
const TREND_PAD = 8;

export function UsageTrendChart({ daily, formatCount, title }: { daily: readonly UsageDailyRow[]; formatCount: (value: number) => string; title: string }) {
  if (daily.length === 0) return null;
  const points = trendPoints(daily, TREND_W, TREND_H, TREND_PAD);
  const polyline = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = `${TREND_PAD},${TREND_H - 2} ${polyline} ${TREND_W - TREND_PAD},${TREND_H - 2}`;
  const max = Math.max(...daily.map((day) => day.total), 1);
  const labelIndexes = trendLabelIndexes(daily.length);
  const columnWidth = TREND_W / daily.length + 1;
  // The viewBox stretches to the panel's width (preserveAspectRatio="none"), so
  // text lives in HTML above and below the SVG, never inside it; the stroke
  // keeps its width through vector-effect.
  const hoverTargets = daily.length <= 400
    ? daily.map((day, index) => (
      <rect
        key={day.date}
        x={points[index]!.x - columnWidth / 2}
        y={0}
        width={columnWidth}
        height={TREND_H}
        fill="transparent"
      >
        <title>{`${day.date} · ${formatCount(day.total)} · ${day.messages}`}</title>
      </rect>
    ))
    : null;
  return (
    <div className="usage-trend">
      <span className="usage-trend-max">{formatCount(max)}</span>
      <svg
        viewBox={`0 0 ${TREND_W} ${TREND_H}`}
        className="usage-trend-svg"
        role="img"
        aria-label={title}
        preserveAspectRatio="none"
      >
        <polygon points={area} className="usage-trend-area" />
        <polyline points={polyline} className="usage-trend-line" fill="none" />
        {hoverTargets}
      </svg>
      <div className="usage-trend-labels">
        {labelIndexes.map((index) => {
          const point = points[index]!;
          const left = (point.x / TREND_W) * 100;
          const align = index === 0 ? "start" : index === daily.length - 1 ? "end" : "center";
          return (
            <span
              key={index}
              className="usage-trend-label"
              style={{
                left: `${left}%`,
                transform: align === "center" ? "translateX(-50%)" : align === "end" ? "translateX(-100%)" : undefined,
                textAlign: align,
              }}
            >
              {daily[index]!.date.slice(5)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Heatmap (one full-width strip, one cell per day of the range)
// ---------------------------------------------------------------------------

export const HEAT_LEVELS = 4;

/** 0 (empty) .. HEAT_LEVELS. Exported for tests. */
export function heatLevel(total: number, max: number): number {
  if (total <= 0 || max <= 0) return 0;
  const ratio = total / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return HEAT_LEVELS;
}

/**
 * One cell per day of the range — days without usage are level 0 — stretched
 * to fill the panel's width (grid-template-columns: repeat(days, 1fr)).
 */
export function UsageHeatmap({ daily, formatCount }: { daily: readonly UsageDailyRow[]; formatCount: (value: number) => string }) {
  if (daily.length === 0) return null;
  const max = Math.max(...daily.map((day) => day.total), 1);
  return (
    <div
      className="usage-heatmap"
      role="img"
      aria-hidden="true"
      style={{ gridTemplateColumns: `repeat(${daily.length}, 1fr)` }}
    >
      {daily.map((day) => (
        <span
          key={day.date}
          className="usage-heat-cell"
          data-level={heatLevel(day.total, max)}
          title={`${day.date} · ${formatCount(day.total)}`}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bar list (models, tools, projects)
// ---------------------------------------------------------------------------

export interface UsageBarItem {
  key: string;
  label: string;
  value: number;
  hint?: string;
}

/** The bar's percentage width (0-100). Exported for tests. */
export function barPercent(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(2, Math.round((value / max) * 100));
}

export function UsageBarList({ items, formatValue }: { items: readonly UsageBarItem[]; formatValue: (value: number) => string }) {
  if (items.length === 0) return null;
  const max = Math.max(...items.map((item) => item.value), 1);
  return (
    <ul className="usage-bar-list">
      {items.map((item) => (
        <li key={item.key} className="usage-bar-row">
          <span className="usage-bar-label" title={item.label}>{item.label}</span>
          <span className="usage-bar-track" aria-hidden="true">
            <span className="usage-bar-fill" style={{ width: `${barPercent(item.value, max)}%` }} />
          </span>
          <span className="usage-bar-value">{formatValue(item.value)}{item.hint ? ` · ${item.hint}` : ""}</span>
        </li>
      ))}
    </ul>
  );
}
