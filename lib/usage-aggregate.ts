// Server-side aggregation of the local session history for Settings › Usage.
// Reads every session file pi wrote under ~/.pi/agent/sessions and folds it
// into per-local-day buckets, with an incremental file cache: session files
// are append-only, so a file whose size+mtime fingerprint is unchanged never
// gets re-read.
//
// Accounting rules mirror the existing pure helpers exactly, so the numbers
// agree with the stats popover for the same entries:
// - usage carriers and message/tool counting: computeSessionStats() (lib/session-stats.ts)
// - active-time gap rules: computeSessionTotalActiveMs() (lib/session-timing.ts)
// Entries at or before the session header's timestamp are inherited history
// (a fork's copied prefix, a side chat's inherited entries) and are skipped,
// the same cut sideOwnEntries() makes for side chats. Sub-agent sessions are
// counted: they are the user's usage too.

import { readFile, stat } from "node:fs/promises";
import { listAllSessions } from "./session-reader";
import type { SessionInfo } from "./types";
import {
  isUsageRangeDays,
  type UsageDailyRow,
  type UsageModelRow,
  type UsageProjectRow,
  type UsageRangeDays,
  type UsageSnapshot,
  type UsageToolRow,
} from "./usage-types";

// ============================================================================
// Day buckets
// ============================================================================

interface ModelDayUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

interface DayBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  messages: number;
  toolCalls: number;
  activeMs: number;
  /** Token-weighted hour histogram, local hours. */
  hours: number[];
  models: Map<string, ModelDayUsage>;
  tools: Map<string, number>;
}

/** One folded session file: the cache unit of the aggregator. */
export interface UsageFileAggregate {
  /** `${size}:${mtimeMs}`, the fingerprint session-reader uses too. */
  fingerprint: string;
  sessionId: string;
  cwd: string | null;
  sessionActiveMs: number;
  days: Map<string, DayBucket>;
}

function emptyDay(): DayBucket {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0,
    cost: 0, messages: 0, toolCalls: 0, activeMs: 0,
    hours: new Array<number>(24).fill(0),
    models: new Map(),
    tools: new Map(),
  };
}

function emptyModel(): ModelDayUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

// Local-calendar day keys: "YYYY-MM-DD" in the server's timezone. Dictionary
// order equals calendar order for same-format keys, which range cuts rely on.
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function localDayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function nextDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return localDayKey(new Date(y!, m! - 1, d! + 1).getTime());
}

function previousDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return localDayKey(new Date(y!, m! - 1, d! - 1).getTime());
}

// ============================================================================
// Folding one session file (pure, no IO — unit-tested directly)
// ============================================================================

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function modelLabel(provider: unknown, modelId: unknown): string | null {
  return typeof provider === "string" && provider && typeof modelId === "string" && modelId
    ? `${provider}/${modelId}`
    : null;
}

function isTimingType(type: unknown): boolean {
  return type === "message" || type === "compaction" || type === "branch_summary" || type === "custom_message";
}

function usageOf(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const usage = entry.type === "message" ? (entry.message as Record<string, unknown> | undefined)?.usage : entry.usage;
  return typeof usage === "object" && usage !== null ? usage as Record<string, unknown> : undefined;
}

function addDayUsage(bucket: DayBucket, usage: Record<string, unknown>): void {
  const input = num(usage.input);
  const output = num(usage.output);
  const cacheRead = num(usage.cacheRead);
  const cacheWrite = num(usage.cacheWrite);
  const cost = num((usage.cost as Record<string, unknown> | undefined)?.total);
  bucket.input += input;
  bucket.output += output;
  bucket.cacheRead += cacheRead;
  bucket.cacheWrite += cacheWrite;
  bucket.total += input + output + cacheRead + cacheWrite;
  bucket.cost += cost;
}

function addModelUsage(models: Map<string, ModelDayUsage>, model: string, usage: Record<string, unknown>): void {
  const row = models.get(model) ?? emptyModel();
  row.input += num(usage.input);
  row.output += num(usage.output);
  row.cacheRead += num(usage.cacheRead);
  row.cacheWrite += num(usage.cacheWrite);
  row.total += num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
  row.cost += num((usage.cost as Record<string, unknown> | undefined)?.total);
  models.set(model, row);
}

export interface FoldedSession {
  sessionId: string;
  cwd: string | null;
  isSubagent: boolean;
  /** The session's whole active time (sum of its day buckets). */
  sessionActiveMs: number;
  days: Map<string, DayBucket>;
}

/**
 * The session's first model_change label, or null: entries before the first
 * one still attribute to it (the model pi started the session with). A light
 * peek that stops at the first find — pi writes it as one of the first lines.
 */
function peekFirstModelChange(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).type === "model_change") {
        return modelLabel((parsed as Record<string, unknown>).provider, (parsed as Record<string, unknown>).modelId);
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Fold one session file's lines into per-day buckets. `lines` are the JSONL
 * lines after the header. Malformed lines (a torn tail line among them) and
 * entries without a parsable timestamp are skipped; entries at or before the
 * header's timestamp are inherited history and skipped too. Returns null when
 * the header itself is unusable.
 */
export function foldSessionLines(header: unknown, lines: readonly string[]): FoldedSession | null {
  if (typeof header !== "object" || header === null) return null;
  const head = header as Record<string, unknown>;
  if (head.type !== "session" || typeof head.timestamp !== "string") return null;
  const headerTs = head.timestamp;

  const days = new Map<string, DayBucket>();
  let currentModel: string | null = null;
  const firstModelChange = peekFirstModelChange(lines);
  let prevTimingTs: number | undefined;

  for (const line of lines) {
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue; // Torn tail line or corrupt row.
    }

    const entryTs = entry.timestamp;
    if (typeof entryTs !== "string") continue;
    const ts = Date.parse(entryTs);
    if (!Number.isFinite(ts)) continue;
    if (entryTs < headerTs) continue; // Inherited fork/side prefix.

    if (entry.type === "model_change") {
      currentModel = modelLabel(entry.provider, entry.modelId);
      continue;
    }

    // Model attribution: a usage entry names its model; an assistant message
    // names its own; otherwise the last model_change (or, before the first
    // one, the session's first model_change); else "unknown".
    const message = entry.type === "message" && typeof entry.message === "object" && entry.message !== null
      ? entry.message as Record<string, unknown>
      : undefined;
    let model: string;
    if (entry.type === "usage") {
      model = modelLabel(entry.provider, entry.model) ?? currentModel ?? firstModelChange ?? "unknown";
    } else if (message?.role === "assistant") {
      model = modelLabel(message.provider, message.model) ?? currentModel ?? firstModelChange ?? "unknown";
    } else {
      model = currentModel ?? firstModelChange ?? "unknown";
    }

    const usage = usageOf(entry);
    const dayKey = localDayKey(ts);

    if (usage) {
      const day = days.get(dayKey) ?? (days.set(dayKey, emptyDay()), days.get(dayKey)!);
      addDayUsage(day, usage);
      day.hours[new Date(ts).getHours()] += num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
      addModelUsage(day.models, model, usage);
    }

    if (entry.type === "message" && message) {
      const day = days.get(dayKey) ?? (days.set(dayKey, emptyDay()), days.get(dayKey)!);
      // Like computeSessionStats(), every message entry counts, whatever its role.
      day.messages += 1;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (typeof block !== "object" || block === null || (block as Record<string, unknown>).type !== "toolCall") continue;
          const call = block as Record<string, unknown>;
          day.toolCalls += 1;
          const name = typeof call.toolName === "string" && call.toolName
            ? call.toolName
            : typeof call.name === "string" ? call.name : "";
          if (name) day.tools.set(name, (day.tools.get(name) ?? 0) + 1);
        }
      }
    }

    // Active time, mirroring computeSessionTotalActiveMs(): gaps ending at a
    // user or bash-execution entry are human idle; each counted gap is booked
    // to the local day of the entry that closes it, so the per-day buckets sum
    // to the whole session's total.
    if (isTimingType(entry.type)) {
      const role = entry.type === "message" ? message?.role : undefined;
      if (role === "user" || role === "bashExecution") {
        prevTimingTs = ts;
      } else {
        if (prevTimingTs !== undefined && ts > prevTimingTs) {
          const day = days.get(dayKey) ?? (days.set(dayKey, emptyDay()), days.get(dayKey)!);
          day.activeMs += ts - prevTimingTs;
        }
        prevTimingTs = ts;
      }
    }
  }

  return {
    sessionId: typeof head.id === "string" ? head.id : "",
    cwd: typeof head.cwd === "string" ? head.cwd : null,
    isSubagent: typeof head.parentSession === "string" && head.parentSession !== "",
    sessionActiveMs: [...days.values()].reduce((acc, day) => acc + day.activeMs, 0),
    days,
  };
}

// ============================================================================
// Merging folded files into a snapshot
// ============================================================================

function streaks(activeDates: Set<string>, todayKey: string): { current: number; longest: number } {
  if (activeDates.size === 0) return { current: 0, longest: 0 };
  const sorted = [...activeDates].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = nextDayKey(sorted[i - 1]!) === sorted[i] ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  let cursor = todayKey;
  if (!activeDates.has(cursor)) cursor = previousDayKey(cursor);
  let current = 0;
  while (activeDates.has(cursor)) {
    current += 1;
    cursor = previousDayKey(cursor);
  }
  return { current, longest };
}

/** Merge folded files into the API snapshot for one range. Exported for tests. */
export function mergeUsageSnapshot(
  files: readonly { sessionId: string; cwd: string | null; sessionActiveMs?: number; days: Map<string, DayBucket> }[],
  range: UsageRangeDays,
  meta: { files: number; skipped: number },
  now: Date = new Date(),
): UsageSnapshot {
  const todayKey = localDayKey(now.getTime());
  let cutoffKey: string | null = null;
  if (range !== "all") {
    const [y, m, d] = todayKey.split("-").map(Number);
    cutoffKey = localDayKey(new Date(y!, m! - 1, d! - (range - 1)).getTime());
  }

  const merged = new Map<string, DayBucket>();
  const activeDates = new Set<string>();
  const sessionActive = new Set<string>();
  const projectTotals = new Map<string, { total: number; cost: number; sessions: Set<string> }>();
  const models = new Map<string, UsageModelRow>();
  const tools = new Map<string, number>();

  for (const file of files) {
    for (const [date, bucket] of file.days) {
      if (cutoffKey !== null && date < cutoffKey) continue;
      const day = merged.get(date) ?? (merged.set(date, emptyDay()), merged.get(date)!);
      day.input += bucket.input;
      day.output += bucket.output;
      day.cacheRead += bucket.cacheRead;
      day.cacheWrite += bucket.cacheWrite;
      day.total += bucket.total;
      day.cost += bucket.cost;
      day.messages += bucket.messages;
      day.toolCalls += bucket.toolCalls;
      day.activeMs += bucket.activeMs;
      for (let h = 0; h < 24; h++) day.hours[h]! += bucket.hours[h]!;
      for (const [model, usage] of bucket.models) {
        const dayRow = day.models.get(model) ?? emptyModel();
        dayRow.input += usage.input;
        dayRow.output += usage.output;
        dayRow.cacheRead += usage.cacheRead;
        dayRow.cacheWrite += usage.cacheWrite;
        dayRow.total += usage.total;
        dayRow.cost += usage.cost;
        day.models.set(model, dayRow);
        const row = models.get(model) ?? { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, share: 0 };
        row.input += usage.input;
        row.output += usage.output;
        row.cacheRead += usage.cacheRead;
        row.cacheWrite += usage.cacheWrite;
        row.total += usage.total;
        row.cost += usage.cost;
        models.set(model, row);
      }
      for (const [name, count] of bucket.tools) tools.set(name, (tools.get(name) ?? 0) + count);

      if (bucket.messages > 0 || bucket.total > 0) {
        activeDates.add(date);
        sessionActive.add(file.sessionId);
        if (file.cwd !== null) {
          const project = projectTotals.get(file.cwd) ?? { total: 0, cost: 0, sessions: new Set<string>() };
          project.total += bucket.total;
          project.cost += bucket.cost;
          project.sessions.add(file.sessionId);
          projectTotals.set(file.cwd, project);
        }
      }
    }
  }

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  let messages = 0;
  let totalActiveMs = 0;
  const hourTotals = new Array<number>(24).fill(0);
  for (const day of merged.values()) {
    tokens.input += day.input;
    tokens.output += day.output;
    tokens.cacheRead += day.cacheRead;
    tokens.cacheWrite += day.cacheWrite;
    tokens.total += day.total;
    cost += day.cost;
    messages += day.messages;
    totalActiveMs += day.activeMs;
    for (let h = 0; h < 24; h++) hourTotals[h]! += day.hours[h]!;
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

  const modelRows = [...models.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
  for (const row of modelRows) row.share = tokens.total > 0 ? row.total / tokens.total : 0;
  // The trend chart draws one line per model: the range's top 6.
  const trendModelKeys = new Set(modelRows.slice(0, 6).map((row) => row.model));
  const toolRows = [...tools.entries()]
    .map(([name, count]): UsageToolRow => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const projectRows = [...projectTotals.entries()]
    .map(([cwd, p]): UsageProjectRow => ({ cwd, total: p.total, cost: p.cost, sessions: p.sessions.size }))
    .sort((a, b) => b.total - a.total || a.cwd.localeCompare(b.cwd));

  const dates = [...merged.keys()].sort();
  const fromKey = cutoffKey ?? dates[0] ?? todayKey;
  const daily: UsageDailyRow[] = [];
  for (let key = fromKey; key <= todayKey; key = nextDayKey(key)) {
    const day = merged.get(key);
    const dayModels: Record<string, number> = {};
    if (day) {
      for (const [model, usage] of day.models) {
        if (trendModelKeys.has(model)) dayModels[model] = (dayModels[model] ?? 0) + usage.total;
      }
    }
    daily.push({
      date: key,
      input: day?.input ?? 0,
      output: day?.output ?? 0,
      cacheRead: day?.cacheRead ?? 0,
      cacheWrite: day?.cacheWrite ?? 0,
      total: day?.total ?? 0,
      cost: day?.cost ?? 0,
      messages: day?.messages ?? 0,
      models: dayModels,
    });
  }
  const peakDayTokens = daily.reduce((acc, day) => Math.max(acc, day.total), 0);
  const longestSessionActiveMs = files.reduce((acc, file) => Math.max(acc, file.sessionActiveMs ?? 0), 0);

  const cacheDenominator = tokens.cacheRead + tokens.input;
  let peakHour: number | null = null;
  let peakTokens = 0;
  for (let h = 0; h < 24; h++) {
    if (hourTotals[h]! > peakTokens) {
      peakTokens = hourTotals[h]!;
      peakHour = h;
    }
  }

  const { current, longest } = streaks(activeDates, todayKey);

  return {
    generatedAt: now.toISOString(),
    range: { days: range === "all" ? null : range, from: dates.length > 0 ? fromKey : null, to: todayKey },
    meta,
    overview: {
      tokens,
      cost,
      sessions: sessionActive.size,
      messages,
      activeDays: activeDates.size,
      peakDayTokens,
      longestSessionActiveMs,
      topModel: modelRows[0] ? { model: modelRows[0].model, share: modelRows[0].share } : null,
      totalActiveMs,
    },
    activity: {
      currentStreakDays: current,
      longestStreakDays: longest,
      cacheHitRate: cacheDenominator > 0 ? tokens.cacheRead / cacheDenominator : null,
      peakHour,
    },
    daily,
    models: modelRows.slice(0, 10),
    tools: toolRows.slice(0, 10),
    projects: projectRows.slice(0, 8),
  };
}

// ============================================================================
// Incremental file cache (globalThis, hot-reload safe; see session-reader.ts)
// ============================================================================

declare global {
  var __piUsageFileCache: Map<string, UsageFileAggregate> | undefined;
  var __piUsageFilesPromise: Promise<{ cache: Map<string, UsageFileAggregate>; meta: { files: number; skipped: number } }> | undefined;
}

export function invalidateUsageFileCache(): void {
  globalThis.__piUsageFileCache = undefined;
  globalThis.__piUsageFilesPromise = undefined;
}

async function fingerprint(path: string): Promise<string | null> {
  try {
    const stats = await stat(path);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

async function foldFile(info: SessionInfo): Promise<UsageFileAggregate | null> {
  const fp = await fingerprint(info.path);
  if (fp === null) return null;
  let text: string;
  try {
    // Async read: each awaited file yields the event loop, so a full first
    // aggregate never blocks SSE heartbeats the way a synchronous read would.
    text = await readFile(info.path, "utf8");
  } catch {
    return null;
  }
  // The file may have grown while we read it. Rather than cache a half state,
  // mark the result unstable: the next request re-reads it whole.
  const fpAfter = await fingerprint(info.path);
  const stable = fpAfter !== null && fpAfter === fp;

  const firstNewline = text.indexOf("\n");
  const headerText = firstNewline === -1 ? text : text.slice(0, firstNewline);
  let header: unknown;
  try {
    header = JSON.parse(headerText);
  } catch {
    return null;
  }
  const body = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  const folded = foldSessionLines(header, body.split("\n"));
  if (!folded) return null;
  return {
    fingerprint: stable ? fp! : `${fp!}:unstable`,
    sessionId: folded.sessionId || info.id,
    cwd: folded.cwd ?? info.cwd,
    sessionActiveMs: folded.sessionActiveMs,
    days: folded.days,
  };
}

async function buildFileAggregates(force: boolean): Promise<{ cache: Map<string, UsageFileAggregate>; meta: { files: number; skipped: number } }> {
  const cache = globalThis.__piUsageFileCache ??= new Map<string, UsageFileAggregate>();
  const sessions = await listAllSessions({ force });
  const seen = new Set<string>();
  const pending: SessionInfo[] = [];
  let reused = 0;

  for (const info of sessions) {
    seen.add(info.path);
    const cached = cache.get(info.path);
    if (cached) {
      const fp = await fingerprint(info.path);
      if (fp !== null && fp === cached.fingerprint) {
        reused += 1;
        continue;
      }
      cache.delete(info.path);
    }
    pending.push(info);
  }
  for (const path of [...cache.keys()]) {
    if (!seen.has(path)) cache.delete(path);
  }

  let folded = 0;
  for (const info of pending) {
    const aggregate = await foldFile(info);
    if (!aggregate) continue;
    folded += 1;
    // An unstable fingerprint (the file changed mid-read) never matches the
    // stat of a later request, so that request re-reads the file whole.
    cache.set(info.path, aggregate);
  }
  return { cache, meta: { files: sessions.length, skipped: sessions.length - reused - folded } };
}

/**
 * The Settings › Usage answer for one range. Concurrent callers share the
 * (incremental) file build; merging per range is cheap. `force` re-reads the
 * session list and bypasses the shared in-flight build.
 */
export async function getUsageSnapshot(options: { range?: UsageRangeDays; force?: boolean } = {}): Promise<UsageSnapshot> {
  const range = isUsageRangeDays(options.range) ? options.range : "all";
  const force = options.force === true;

  let files: Map<string, UsageFileAggregate>;
  let meta = { files: 0, skipped: 0 };
  if (!force && globalThis.__piUsageFilesPromise) {
    const shared = await globalThis.__piUsageFilesPromise;
    files = shared.cache;
    meta = shared.meta;
  } else {
    const promise = buildFileAggregates(force);
    globalThis.__piUsageFilesPromise = promise;
    const clear = () => {
      if (globalThis.__piUsageFilesPromise === promise) globalThis.__piUsageFilesPromise = undefined;
    };
    promise.then(clear, clear);
    try {
      const built = await promise;
      files = built.cache;
      meta = built.meta;
    } finally {
      clear();
    }
  }

  const list = [...files.values()].map((aggregate) => ({
    sessionId: aggregate.sessionId,
    cwd: aggregate.cwd,
    sessionActiveMs: aggregate.sessionActiveMs,
    days: aggregate.days,
  }));
  return mergeUsageSnapshot(list, range, meta, new Date());
}
