// Pure-presentational charts of Settings › Usage (components/UsageConfig.tsx).
// No i18n and no state here: labels and formatted values arrive as props, and
// every chart is decorative (aria-hidden) with the readable detail in the
// neighboring lists or in each cell's title.

import type { UsageDailyRow } from "@/lib/usage-types";

function nextDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y!, m! - 1, d! + 1);
  const pad = (value: number) => (value < 10 ? `0${value}` : String(value));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------------------------------------------------------------------------
// Trend chart (SVG polyline)
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
const TREND_H = 150;

export function UsageTrendChart({ daily, formatCount, title }: { daily: readonly UsageDailyRow[]; formatCount: (value: number) => string; title: string }) {
  if (daily.length === 0) return null;
  const points = trendPoints(daily, TREND_W, TREND_H);
  const polyline = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = `8,${TREND_H - 2} ${polyline} ${TREND_W - 2},${TREND_H - 2}`;
  const max = Math.max(...daily.map((day) => day.total), 1);
  const labelIndexes = trendLabelIndexes(daily.length);
  const hoverTargets = daily.length <= 400
    ? daily.map((day, index) => (
      <rect
        key={day.date}
        x={points[index]!.x - (TREND_W / daily.length) / 2}
        y={0}
        width={TREND_W / daily.length + 1}
        height={TREND_H}
        fill="transparent"
      >
        <title>{`${day.date} · ${formatCount(day.total)} · ${day.messages}`}</title>
      </rect>
    ))
    : null;
  return (
    <svg
      viewBox={`0 0 ${TREND_W} ${TREND_H}`}
      className="usage-trend-chart"
      role="img"
      aria-label={title}
      preserveAspectRatio="none"
    >
      <polygon points={area} className="usage-trend-area" />
      <polyline points={polyline} className="usage-trend-line" fill="none" />
      <text x={4} y={12} className="usage-trend-max">{formatCount(max)}</text>
      {labelIndexes.map((index) => (
        <text
          key={index}
          x={points[index]!.x}
          y={TREND_H - 2}
          textAnchor={index === 0 ? "start" : index === daily.length - 1 ? "end" : "middle"}
          className="usage-trend-label"
        >
          {daily[index]!.date.slice(5)}
        </text>
      ))}
      {hoverTargets}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Heatmap (CSS grid, one column per week)
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

function mondayOffset(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  const day = new Date(y!, m! - 1, d!).getDay(); // 0 = Sunday
  return (day + 6) % 7; // 0 = Monday
}

export function UsageHeatmap({ daily, formatCount }: { daily: readonly UsageDailyRow[]; formatCount: (value: number) => string }) {
  if (daily.length === 0) return null;
  const byDate = new Map(daily.map((day) => [day.date, day]));
  const first = daily[0]!.date;
  const last = daily[daily.length - 1]!.date;
  const max = Math.max(...daily.map((day) => day.total), 1);

  // Start at the Monday of the first day's week so columns align to weeks.
  let cursor = first;
  for (let i = 0; i < mondayOffset(first); i++) cursor = previousDay(cursor);
  const cells: { date: string; day: UsageDailyRow | undefined; offset: number }[] = [];
  let offset = 0;
  while (cursor <= last) {
    if (cursor >= first) cells.push({ date: cursor, day: byDate.get(cursor), offset });
    cursor = nextDay(cursor);
    offset += 1;
  }
  return (
    <div className="usage-heatmap" role="img" aria-hidden="true">
      {cells.map((cell) => (
        <span
          key={cell.date}
          className="usage-heat-cell"
          data-level={cell.day ? heatLevel(cell.day.total, max) : 0}
          title={cell.day ? `${cell.date} · ${formatCount(cell.day.total)}` : cell.date}
        />
      ))}
    </div>
  );
}

function previousDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y!, m! - 1, d! - 1);
  const pad = (value: number) => (value < 10 ? `0${value}` : String(value));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
