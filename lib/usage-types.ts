// Client-safe types of Settings › Usage: the shape `GET /api/usage` answers
// with and UsageConfig renders. The aggregation itself is server-side
// (lib/usage-aggregate.ts) and must not be imported from client code.

export type UsageRangeDays = 7 | 30 | 90 | "all";

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageModelRow {
  /** "provider/modelId", or "unknown" when no model can be attributed. */
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  /** Share of all tokens, 0..1. */
  share: number;
}

export interface UsageToolRow {
  name: string;
  count: number;
}

export interface UsageProjectRow {
  cwd: string;
  total: number;
  cost: number;
  sessions: number;
}

export interface UsageDailyRow {
  /** Local calendar day, "YYYY-MM-DD" (server timezone). */
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  messages: number;
}

export interface UsageSnapshot {
  generatedAt: string;
  range: {
    /** Null for "all". */
    days: number | null;
    /** First covered local day; null when there is no data at all. */
    from: string | null;
    to: string;
  };
  meta: {
    files: number;
    skipped: number;
  };
  overview: {
    tokens: UsageTokens;
    cost: number;
    sessions: number;
    messages: number;
    activeDays: number;
    topModel: { model: string; share: number } | null;
    totalActiveMs: number;
  };
  activity: {
    currentStreakDays: number;
    longestStreakDays: number;
    /** cacheRead / (cacheRead + input); null when the denominator is 0. */
    cacheHitRate: number | null;
    /** Hour 0-23 with the most tokens; null when there is no data. */
    peakHour: number | null;
  };
  daily: UsageDailyRow[];
  models: UsageModelRow[];
  tools: UsageToolRow[];
  projects: UsageProjectRow[];
}

export const USAGE_RANGE_VALUES: readonly UsageRangeDays[] = [7, 30, 90, "all"];

export function isUsageRangeDays(value: unknown): value is UsageRangeDays {
  return value === 7 || value === 30 || value === 90 || value === "all";
}
