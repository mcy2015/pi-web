// Pure-presentational charts of the Usage top panel (components/UsagePanel.tsx).
// No i18n and no state here: labels and formatted values arrive as props, and
// every chart is decorative (aria-hidden) with the readable detail in the
// neighboring lists or in each cell's title.

import type { UsageDailyRow } from "@/lib/usage-types";

// ---------------------------------------------------------------------------
// Trend chart (ZCode's daily model trend): one line per model (top 6), HTML
// labels around a stretched-lines-only SVG.
// ---------------------------------------------------------------------------

/** Six fixed chart colors, defined as CSS variables on .usage-panel. */
export const USAGE_CHART_COLORS = [
  "var(--usage-c1)", "var(--usage-c2)", "var(--usage-c3)",
  "var(--usage-c4)", "var(--usage-c5)", "var(--usage-c6)",
] as const;

export function chartColor(index: number): string {
  return USAGE_CHART_COLORS[index % USAGE_CHART_COLORS.length]!;
}

export interface TrendPoint {
  x: number;
  y: number;
}

/** Map a per-day value series into viewBox coordinates. Exported for tests. */
export function trendPoints(values: readonly number[], width: number, height: number, padding = 8): TrendPoint[] {
  if (values.length === 0) return [];
  const max = Math.max(...values, 1);
  const span = width - padding * 2;
  const step = values.length > 1 ? span / (values.length - 1) : 0;
  return values.map((value, index) => ({
    x: padding + step * index,
    y: height - padding - (value / max) * (height - padding * 2),
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
const TREND_H = 96;
const TREND_PAD = 8;

export function UsageTrendChart({
  daily,
  models,
  formatCount,
  title,
}: {
  daily: readonly UsageDailyRow[];
  /** The models to draw, in order (the range's top 6). */
  models: readonly string[];
  formatCount: (value: number) => string;
  title: string;
}) {
  if (daily.length === 0) return null;
  const labelIndexes = trendLabelIndexes(daily.length);
  const totalMax = Math.max(...daily.map((day) => day.total), 1);
  const columnWidth = TREND_W / daily.length + 1;
  const xFor = (index: number) => TREND_PAD + (daily.length > 1 ? (TREND_W - TREND_PAD * 2) / (daily.length - 1) : 0) * index;
  const lines = models.map((model, modelIndex) => {
    const values = daily.map((day) => day.models[model] ?? 0);
    const points = trendPoints(values, TREND_W, TREND_H, TREND_PAD);
    return {
      model,
      color: chartColor(modelIndex),
      polyline: points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "),
      some: values.some((value) => value > 0),
    };
  });
  return (
    <div className="usage-trend">
      <div className="usage-trend-legend" role="list">
        {lines.filter((line) => line.some).map((line) => (
          <span key={line.model} className="usage-trend-legend-item" role="listitem">
            <span className="usage-trend-legend-dot" style={{ backgroundColor: line.color }} />
            <span className="usage-trend-legend-label" title={line.model}>{line.model}</span>
          </span>
        ))}
      </div>
      <span className="usage-trend-max">{formatCount(totalMax)}</span>
      <svg
        viewBox={`0 0 ${TREND_W} ${TREND_H}`}
        className="usage-trend-svg"
        role="img"
        aria-label={title}
        preserveAspectRatio="none"
      >
        {lines.filter((line) => line.some).map((line) => (
          <polyline key={line.model} points={line.polyline} className="usage-trend-line" stroke={line.color} fill="none" />
        ))}
        {daily.length <= 400
          ? daily.map((day, index) => (
            <rect key={day.date} x={xFor(index) - columnWidth / 2} y={0} width={columnWidth} height={TREND_H} fill="transparent">
              <title>{`${day.date} · ${formatCount(day.total)}`}</title>
            </rect>
          ))
          : null}
      </svg>
      <div className="usage-trend-labels">
        {labelIndexes.map((index) => {
          const left = (xFor(index) / TREND_W) * 100;
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
// Model donut (ZCode's model usage pie): top 5 + "other", total in the middle.
// ---------------------------------------------------------------------------

export interface DonutEntry {
  key: string;
  label: string;
  value: number;
  /** 0..1 of the total. */
  share: number;
  color: string;
}

/** Top 5 models plus a merged "other" entry when there are more. Exported for tests. */
export function donutEntries(
  models: readonly { model: string; total: number }[],
  otherLabel: string,
): DonutEntry[] {
  const withUsage = models.filter((row) => row.total > 0);
  if (withUsage.length <= 6) {
    return withUsage.map((row, index) => ({
      key: row.model,
      label: row.model,
      value: row.total,
      share: 0,
      color: chartColor(index),
    }));
  }
  const top = withUsage.slice(0, 5);
  const rest = withUsage.slice(5).reduce((acc, row) => acc + row.total, 0);
  const entries: DonutEntry[] = top.map((row, index) => ({
    key: row.model,
    label: row.model,
    value: row.total,
    share: 0,
    color: chartColor(index),
  }));
  entries.push({ key: "__other__", label: otherLabel, value: rest, share: 0, color: chartColor(5) });
  return entries;
}

/** Each donut arc's dash values on a circle of the given circumference. Exported for tests. */
export function donutArcs(
  entries: readonly DonutEntry[],
  circumference: number,
): { entry: DonutEntry; dash: number; gap: number; offset: number }[] {
  const total = entries.reduce((acc, entry) => acc + entry.value, 0);
  const arcs: { entry: DonutEntry; dash: number; gap: number; offset: number }[] = []
  let used = 0;
  for (const entry of entries) {
    const share = total > 0 ? entry.value / total : 0;
    const dash = share * circumference;
    arcs.push({ entry, dash, gap: Math.max(0, circumference - dash), offset: -used * circumference });
    used += share;
  }
  for (const arc of arcs) arc.entry.share = total > 0 ? arc.entry.value / total : 0;
  return arcs;
}

export function UsageModelDonut({
  models,
  otherLabel,
  formatCount,
  tokenUnit,
}: {
  models: readonly { model: string; total: number }[];
  otherLabel: string;
  formatCount: (value: number) => string;
  tokenUnit: string;
}) {
  const entries = donutEntries(models, otherLabel);
  if (entries.length === 0) return null;
  const total = entries.reduce((acc, entry) => acc + entry.value, 0);
  const arcs = donutArcs(entries, 100);
  return (
    <div className="usage-donut">
      <div className="usage-donut-chart">
        <svg viewBox="0 0 120 120" className="usage-donut-svg" role="img" aria-hidden="true">
          <circle cx="60" cy="60" r="44" fill="none" stroke="var(--bg-hover)" strokeWidth="14" />
          {arcs.map((arc) => (
            <circle
              key={arc.entry.key}
              cx="60" cy="60" r="44" fill="none"
              stroke={arc.entry.color}
              strokeWidth="14"
              strokeDasharray={`${arc.dash} ${arc.gap}`}
              strokeDashoffset={arc.offset}
              transform="rotate(-90 60 60)"
            >
              <title>{`${arc.entry.label}: ${formatCount(arc.entry.value)}`}</title>
            </circle>
          ))}
        </svg>
        <div className="usage-donut-center">
          <span className="usage-donut-total">{formatCount(total)}</span>
          <span className="usage-donut-unit">{tokenUnit}</span>
        </div>
      </div>
      <div className="usage-donut-legend" role="list">
        {entries.map((entry) => (
          <div key={entry.key} className="usage-donut-row" role="listitem">
            <span className="usage-donut-dot" style={{ backgroundColor: entry.color }} />
            <span className="usage-donut-name" title={entry.label}>{entry.label}</span>
            <span className="usage-donut-share">{`${Math.round(entry.share * 100)}%`}</span>
            <span className="usage-donut-value">{`${formatCount(entry.value)} ${tokenUnit}`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Heatmap (ZCode's Token activity): 52 weekly columns × 7 days, aligned so the
// latest day with usage sits in the last week; daily / weekly / cumulative.
// ---------------------------------------------------------------------------

export const HEAT_LEVELS = 4;
export const HEATMAP_WEEKS = 52;

/** 0 (empty) .. HEAT_LEVELS. Exported for tests. */
export function heatLevel(total: number, max: number): number {
  if (total <= 0 || max <= 0) return 0;
  return Math.min(HEAT_LEVELS, Math.max(1, Math.ceil((total / max) * HEAT_LEVELS)));
}

export type HeatmapMode = "daily" | "weekly" | "cumulative";

export interface HeatmapDay {
  date: string;
  total: number;
  messages: number;
}

function localDayKeyOf(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => (value < 10 ? `0${value}` : String(value));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDayKey(key: string): number | null {
  const [y, m, d] = key.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) return null;
  const ts = new Date(y, m - 1, d).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function addDays(ts: number, days: number): number {
  const date = new Date(ts);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** An empty cell for a day the history has nothing for. */
function emptyDay(date: string): HeatmapDay {
  return { date, total: 0, messages: 0 };
}

/**
 * The 52-week window: the last column holds the latest day with usage, the
 * window starts at that week's Sunday. Days without usage (before the first
 * session and after the last day inside the final week) are empty cells.
 * Exported for tests.
 */
export function buildHeatmapWeeks(daily: readonly UsageDailyRow[]): HeatmapDay[][] {
  let latestTs: number | null = null;
  for (const day of daily) {
    if (day.total > 0 || day.messages > 0) {
      const ts = parseDayKey(day.date);
      if (ts !== null) latestTs = ts;
    }
  }
  if (latestTs === null) return [];
  const byDate = new Map(daily.map((day) => [day.date, day]));
  const start = addDays(latestTs, -new Date(latestTs).getDay() - (HEATMAP_WEEKS - 1) * 7);
  const weeks: HeatmapDay[][] = [];
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const week: HeatmapDay[] = [];
    for (let d = 0; d < 7; d++) {
      const date = localDayKeyOf(addDays(start, w * 7 + d));
      const found = byDate.get(date);
      week.push(found ? { date, total: found.total, messages: found.messages } : emptyDay(date));
    }
    weeks.push(week);
  }
  return weeks;
}

/**
 * Weekly / cumulative bars (ZCode's dXn): each column's value (its week sum,
 * or the running total up to it), drawn as a bottom-aligned bar whose cell
 * count tracks the value. Exported for tests.
 */
export function heatmapBars(
  weeks: readonly (readonly HeatmapDay[])[],
  mode: "weekly" | "cumulative",
): { values: number[]; messages: number[]; barCells: number[] } {
  const sumTokens = weeks.map((week) => week.reduce((acc, day) => acc + day.total, 0));
  const sumMessages = weeks.map((week) => week.reduce((acc, day) => acc + day.messages, 0));
  const values = mode === "weekly"
    ? sumTokens
    : sumTokens.reduce<number[]>((acc, sum) => {
      acc.push((acc[acc.length - 1] ?? 0) + sum);
      return acc;
    }, []);
  const messages = mode === "weekly"
    ? sumMessages
    : sumMessages.reduce<number[]>((acc, sum) => {
      acc.push((acc[acc.length - 1] ?? 0) + sum);
      return acc;
    }, []);
  const max = Math.max(0, ...values);
  const barCells = values.map((value) => (value <= 0 || max <= 0 ? 0 : Math.min(7, Math.max(1, Math.ceil((value / max) * 7)))));
  return { values, messages, barCells };
}

export interface HeatmapMonthGroup {
  key: string;
  label: string;
  span: number;
}

/** Month labels under the grid (ZCode's pXn/lXn): a column names the day its
 * week starts a month with, same-month neighbours merge, at most 12 labels
 * (earlier ones blank). Exported for tests. */
export function heatmapMonthGroups(
  weeks: readonly (readonly HeatmapDay[])[],
  labelOfMonth: (dateKey: string) => string,
): HeatmapMonthGroup[] {
  const groups: HeatmapMonthGroup[] = [];
  for (const week of weeks) {
    const monthDate = week.find((day) => day.date.endsWith("-01"))?.date ?? week[0]?.date ?? "";
    if (!monthDate) continue;
    const month = monthDate.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === month) last.span += 1;
    else groups.push({ key: month, label: labelOfMonth(monthDate), span: 1 });
  }
  const overflow = Math.max(0, groups.length - 12);
  for (let i = 0; i < overflow; i++) groups[i]!.label = "";
  return groups;
}

export function UsageHeatmap({
  daily,
  mode,
  titleOf,
  labelOfMonth,
}: {
  daily: readonly UsageDailyRow[];
  mode: HeatmapMode;
  titleOf: (day: HeatmapDay, mode: HeatmapMode) => string;
  labelOfMonth: (dateKey: string) => string;
}) {
  const weeks = buildHeatmapWeeks(daily);
  if (weeks.length === 0) return null;
  const bars = mode === "daily" ? null : heatmapBars(weeks, mode);
  const max = bars ? Math.max(0, ...bars.values) : Math.max(1, ...daily.map((day) => day.total));
  const months = heatmapMonthGroups(weeks, labelOfMonth);

  return (
    <div className="usage-heatmap">
      <div className="usage-heatmap-grid" role="img" aria-hidden="true">
        {weeks.map((week, weekIndex) => {
          const weekValue = bars?.values[weekIndex] ?? 0;
          const barCellCount = bars?.barCells[weekIndex] ?? 0;
          const weekLevel = bars ? heatLevel(weekValue, max) : 0;
          const weekEndDate = week[6]?.date ?? week[0]!.date;
          const columnTitle = bars
            ? titleOf({ date: weekEndDate, total: weekValue, messages: bars.messages[weekIndex] ?? 0 }, mode)
            : null;
          return (
            <div key={weekIndex} className={mode !== "daily" ? "usage-heatmap-col is-bar" : "usage-heatmap-col"}>
              {week.map((day, dayIndex) => {
                const filled = bars ? dayIndex >= 7 - barCellCount : true;
                const level = bars ? (filled ? weekLevel : 0) : heatLevel(day.total, max);
                const hasUsage = bars ? filled && weekValue > 0 : day.total > 0;
                const title = bars ? columnTitle : titleOf(day, mode);
                return (
                  <span
                    key={day.date}
                    className="usage-heat-cell"
                    data-level={level}
                    data-has-usage={hasUsage ? "true" : undefined}
                    title={title ?? undefined}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="usage-heatmap-months">
        {months.map((group) => (
          <span key={group.key} className="usage-heatmap-month" style={{ gridColumn: `span ${group.span}` }}>{group.label}</span>
        ))}
      </div>
    </div>
  );
}
