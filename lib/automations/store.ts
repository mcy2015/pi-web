// pi-web-automations.json: the Automations' definitions and their run
// history, following the channels store's rules — writes serialized per
// process, locked against others, replaced atomically, a file that cannot be
// parsed set aside never overwritten, unknown fields of a newer build kept.

import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { serializeByKey } from "../key-serializer";
import { readRegularFileText } from "../regular-file";
import type { Schedule } from "./cron-schedule";

const MAX_BYTES = 4 * 1024 * 1024;
/** The run history keeps the newest N runs; older ones fall off. */
export const RUN_HISTORY_LIMIT = 100;

const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
  onCompromised: (error: Error) => {
    console.warn(`[pi-web] the automations store lock was compromised: ${error.message}`);
  },
};

export class AutomationsStoreLockedError extends Error {
  constructor(message = "Another process holds the automations store lock") {
    super(message);
    this.name = "AutomationsStoreLockedError";
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : null;
}

export interface AutomationModel {
  id: string;
  name: string;
  enabled: boolean;
  schedule: Schedule;
  /** Where each run's session is created. */
  cwd: string;
  prompt: string;
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string | null;
  /** Push a completion notification for each run. */
  notify: boolean;
  /** The scheduler's cache: when this automation is next due. */
  nextDueAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
}

export type RunStatus = "running" | "done" | "failed" | "skipped";

export interface AutomationRun {
  id: string;
  automationId: string;
  trigger: "schedule" | "manual";
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  sessionId: string | null;
  sessionFile: string | null;
  error: string | null;
}

export interface AutomationsFile {
  automations: AutomationModel[];
  runs: AutomationRun[];
}

export const EMPTY_FILE: AutomationsFile = { automations: [], runs: [] };

export function automationsPath(agentDir = getAgentDir()): string {
  return `${agentDir}/pi-web-automations.json`;
}

function setAside(path: string): void {
  const backup = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, backup);
    console.warn(`[pi-web] ${path} could not be parsed; moved it to ${backup}`);
  } catch (error) {
    console.warn(`[pi-web] ${path} could not be parsed and could not be moved aside (${error instanceof Error ? error.message : String(error)})`);
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const text = readRegularFileText(path, MAX_BYTES);
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    setAside(path);
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

async function editFile<T>(
  queueKey: symbol,
  path: string,
  read: () => T,
  edit: (current: T) => { value: T; changed: boolean },
  write: (value: T) => void,
): Promise<T> {
  return serializeByKey(queueKey, path, async () => {
    mkdirSync(dirname(path), { recursive: true });
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(path, LOCK_OPTIONS);
    } catch (error) {
      if (errorCode(error) === "ELOCKED") throw new AutomationsStoreLockedError();
      throw error;
    }
    try {
      const current = read();
      const { value, changed } = edit(current);
      if (changed) {
        write(value);
        return value;
      }
      return current;
    } finally {
      await release().catch(() => {});
    }
  });
}

const QUEUE: symbol = Symbol.for("pi-web:automations-store-queue");

function parseSchedule(raw: unknown): Schedule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.kind === "cron") {
    return typeof record.expr === "string" ? { kind: "cron", expr: record.expr, ...(typeof record.tz === "string" ? { tz: record.tz } : {}) } : null;
  }
  if (record.kind === "at") {
    return typeof record.atMs === "number" && Number.isFinite(record.atMs) ? { kind: "at", atMs: record.atMs } : null;
  }
  if (record.kind === "every") {
    return typeof record.everyMs === "number" && Number.isFinite(record.everyMs) ? { kind: "every", everyMs: record.everyMs } : null;
  }
  return null;
}

function parseAutomation(raw: unknown): AutomationModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const schedule = parseSchedule(record.schedule);
  if (
    typeof record.id !== "string" || record.id === ""
    || typeof record.name !== "string" || record.name.trim() === ""
    || schedule === null
    || typeof record.cwd !== "string" || record.cwd.trim() === ""
    || typeof record.prompt !== "string" || record.prompt.trim() === ""
  ) return null;
  const model = record.model;
  return {
    id: record.id,
    name: record.name,
    enabled: record.enabled === true,
    schedule,
    cwd: record.cwd,
    prompt: record.prompt,
    model: typeof model === "object" && model !== null
      && typeof (model as { provider?: unknown }).provider === "string"
      && typeof (model as { modelId?: unknown }).modelId === "string"
      ? { provider: (model as { provider: string }).provider, modelId: (model as { modelId: string }).modelId }
      : null,
    thinkingLevel: typeof record.thinkingLevel === "string" ? record.thinkingLevel : null,
    notify: record.notify !== false,
    nextDueAt: typeof record.nextDueAt === "number" ? record.nextDueAt : null,
    lastRunAt: typeof record.lastRunAt === "number" ? record.lastRunAt : null,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
  };
}

const RUN_STATUSES: ReadonlySet<string> = new Set(["running", "done", "failed", "skipped"]);

function parseRun(raw: unknown): AutomationRun | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.id !== "string" || record.id === ""
    || typeof record.automationId !== "string"
    || typeof record.startedAt !== "number"
    || typeof record.status !== "string" || !RUN_STATUSES.has(record.status)
  ) return null;
  return {
    id: record.id,
    automationId: record.automationId,
    trigger: record.trigger === "manual" ? "manual" : "schedule",
    startedAt: record.startedAt,
    finishedAt: typeof record.finishedAt === "number" ? record.finishedAt : null,
    status: record.status as RunStatus,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
    sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : null,
    error: typeof record.error === "string" ? record.error : null,
  };
}

export function parseAutomationsFile(raw: Record<string, unknown> | null): AutomationsFile {
  if (raw === null) return { automations: [], runs: [] };
  const automations = Array.isArray(raw.automations)
    ? raw.automations.flatMap((entry) => {
        const parsed = parseAutomation(entry);
        return parsed ? [parsed] : [];
      })
    : [];
  const runs = Array.isArray(raw.runs)
    ? raw.runs.flatMap((entry) => {
        const parsed = parseRun(entry);
        return parsed ? [parsed] : [];
      })
    : [];
  return { automations, runs };
}

export function readAutomations(path = automationsPath()): AutomationsFile {
  return parseAutomationsFile(readJson(path));
}

/** Read-modify-write the whole file (its automations and runs) under the lock. */
export function editAutomations(
  edit: (file: AutomationsFile) => { file: AutomationsFile; changed: boolean },
  path = automationsPath(),
): Promise<AutomationsFile> {
  return editFile(QUEUE, path, () => readAutomations(path), (current) => {
    const result = edit(current);
    return { value: result.file, changed: result.changed };
  }, (file) => {
    const existing = readJson(path);
    const next: Record<string, unknown> = { ...(existing ?? {}) };
    next.automations = file.automations;
    // Newest first, then capped: the freshest history is what survives.
    next.runs = [...file.runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, RUN_HISTORY_LIMIT);
    writeJsonAtomic(path, next);
  });
}

/** The history capped, newest first. */
export function runsOf(file: AutomationsFile): AutomationRun[] {
  return [...file.runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, RUN_HISTORY_LIMIT);
}

export function fileHasRunsInProgress(file: AutomationsFile, automationId: string): boolean {
  return file.runs.some((run) => run.automationId === automationId && run.status === "running");
}

export function fileExistsAt(path: string): boolean {
  return existsSync(path);
}
