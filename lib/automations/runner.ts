// The Automations ticker singleton: one 30-second ticker per process that
// fires due automations, kept in step with the store through
// syncAutomationsRuntime (boot and every Settings change). A fire creates an
// isolated pi session (named "task · time"), sends the prompt, waits for the
// turn's prompt_done — the lesson the Telegram channel paid for — records the
// run, and pushes a completion notification. A run is skipped when the same
// automation is still running (OpenClaw's policy); time missed while the
// server was down is not made up: nextDueAt is recomputed from now.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { getRpcSession, startRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { notifySessionComplete } from "@/lib/web-push";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { editAutomations, readAutomations, type AutomationModel, type AutomationRun } from "./store";
import { nextDueTime, scheduleProblem } from "./cron-schedule";

const TICK_MS = 30_000;

interface RuntimeGlobal {
  ticker: ReturnType<typeof setInterval> | null;
}
const STORE_KEY: symbol = Symbol.for("pi-web:automations-runtime");
function runtime(): RuntimeGlobal {
  const store = globalThis as Record<symbol, RuntimeGlobal | undefined>;
  return (store[STORE_KEY] ??= { ticker: null });
}

/** Starts (or keeps) the ticker. Cheap to call on every boot and API change. */
export function syncAutomationsRuntime(): void {
  if (runtime().ticker !== null) return;
  runtime().ticker = setInterval(() => {
    void tick().catch((error) => {
      console.warn(`[pi-web] automations tick failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, TICK_MS);
  console.log("[pi-web] automations ticker started");
}

async function tick(): Promise<void> {
  const file = readAutomations();
  for (const automation of file.automations) {
    if (!automation.enabled) continue;
    if (scheduleProblem(automation.schedule) !== null) continue;
    let nextDueAt = automation.nextDueAt;
    if (nextDueAt === null) {
      nextDueAt = nextDueTime(automation.schedule, Date.now());
      await persistAutomationPatch(automation.id, { nextDueAt });
      if (nextDueAt === null) continue;
    }
    if (nextDueAt > Date.now()) continue;
    // Due. A run still going means this fire is skipped, not queued.
    if (file.runs.some((run) => run.automationId === automation.id && run.status === "running")) {
      await recordRun({
        id: randomUUID(),
        automationId: automation.id,
        trigger: "schedule",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        status: "skipped",
        sessionId: null,
        sessionFile: null,
        error: "The previous run was still going",
      });
      await persistAutomationPatch(automation.id, { nextDueAt: nextDueTime(automation.schedule, Date.now()) });
      continue;
    }
    // Fire without blocking the ticker: long turns must not delay others.
    void fireAutomation(automation, "schedule").catch((error) => {
      console.warn(`[pi-web] automation "${automation.name}" failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    // The fire's own completion recomputes nextDueAt; advance it now so the
    // next tick does not fire the same minute twice.
    await persistAutomationPatch(automation.id, { nextDueAt: nextDueTime(automation.schedule, Date.now()) });
  }
}

async function persistAutomationPatch(automationId: string, patch: Partial<Pick<AutomationModel, "nextDueAt" | "lastRunAt">>): Promise<void> {
  await editAutomations((file) => {
    let changed = false;
    const automations = file.automations.map((automation) => {
      if (automation.id !== automationId) return automation;
      changed = true;
      return { ...automation, ...patch };
    });
    return { file: { ...file, automations }, changed };
  }).catch((error) => {
    console.warn(`[pi-web] automations: persisting a patch failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function recordRun(run: AutomationRun): Promise<void> {
  await editAutomations((file) => ({
    file: { ...file, runs: [...file.runs.filter((existing) => existing.id !== run.id), run] },
    changed: true,
  })).catch((error) => {
    console.warn(`[pi-web] automations: recording a run failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function finishRun(runId: string, patch: Partial<Pick<AutomationRun, "finishedAt" | "status" | "sessionId" | "sessionFile" | "error">>): Promise<void> {
  await editAutomations((file) => ({
    file: {
      ...file,
      runs: file.runs.map((run) => run.id === runId ? { ...run, ...patch } : run),
    },
    changed: true,
  })).catch(() => {});
}

function runStamp(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** One fire of an automation: an isolated session, one turn, history, push. */
export async function fireAutomation(
  automation: AutomationModel,
  trigger: "schedule" | "manual",
): Promise<{ runId: string; sessionId: string | null; error: string | null }> {
  const runId = randomUUID();
  await recordRun({
    id: runId,
    automationId: automation.id,
    trigger,
    startedAt: Date.now(),
    finishedAt: null,
    status: "running",
    sessionId: null,
    sessionFile: null,
    error: null,
  });
  await persistAutomationPatch(automation.id, { lastRunAt: Date.now() });

  const fail = async (error: string): Promise<{ runId: string; sessionId: null; error: string }> => {
    await finishRun(runId, { finishedAt: Date.now(), status: "failed", error });
    if (automation.notify && trigger === "schedule") {
      await notifySessionComplete(automation.id, `${automation.name} · failed`).catch(() => {});
    }
    return { runId, sessionId: null, error };
  };

  try {
    mkdirSync(automation.cwd, { recursive: true });
  } catch (error) {
    return fail(`The working directory could not be created: ${error instanceof Error ? error.message : String(error)}`);
  }
  allowFileRoot(automation.cwd);

  let wrapper: AgentSessionWrapper;
  let sessionId: string;
  try {
    const tempKey = `__automation__${randomUUID()}`;
    const started = await startRpcSession(tempKey, "", automation.cwd, {
      ...(automation.model ? { initialModel: automation.model } : {}),
      ...(automation.thinkingLevel ? { thinkingLevel: automation.thinkingLevel as never } : {}),
    });
    wrapper = started.session;
    sessionId = started.realSessionId;
  } catch (error) {
    return fail(`Starting the session failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const name = `${automation.name} · ${runStamp()}`;
  try {
    await wrapper.send({ type: "set_session_name", name });
  } catch {
    // A name is cosmetic; the run continues.
  }

  let aborted = false;
  let settleDone!: () => void;
  let settleFailed!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    settleDone = resolve;
    settleFailed = reject;
  });
  const unsubscribe = wrapper.onEvent((event) => {
    if (event.type === "prompt_done") {
      if ((event as { aborted?: boolean }).aborted) aborted = true;
      settleDone();
    } else if (event.type === "prompt_error") {
      settleFailed(new Error((event as { errorMessage?: string }).errorMessage ?? "The turn failed"));
    }
  });

  try {
    await wrapper.send({ type: "prompt", message: automation.prompt });
    await done;
    await finishRun(runId, {
      finishedAt: Date.now(),
      status: aborted ? "skipped" : "done",
      sessionId,
      sessionFile: wrapper.sessionFile,
      error: aborted ? "The turn was stopped" : null,
    });
    invalidateSessionListCache();
    if (automation.notify) {
      await notifySessionComplete(sessionId, name).catch(() => {});
    }
    return { runId, sessionId, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(runId, {
      finishedAt: Date.now(),
      status: "failed",
      sessionId,
      sessionFile: wrapper.sessionFile,
      error: message,
    });
    invalidateSessionListCache();
    if (automation.notify) {
      await notifySessionComplete(sessionId, `${name} · failed`).catch(() => {});
    }
    return { runId, sessionId, error: message };
  } finally {
    unsubscribe();
  }
}

/** What Settings shows: the automations with their next due times. */
export function automationsSnapshot(): { automations: AutomationModel[]; runs: AutomationRun[] } {
  const file = readAutomations();
  return { automations: file.automations, runs: file.runs };
}

export function getAutomationRunWrapper(runSessionId: string): AgentSessionWrapper | undefined {
  return getRpcSession(runSessionId);
}
