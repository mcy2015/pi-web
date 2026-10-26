// GET  /api/automations  — the automations and their recent runs, for the
//                          Settings › Automations panel.
// POST /api/automations  — actions: preview a schedule's next due time,
//                          create/update/delete, set-enabled, run-now. Each
//                          mutation keeps the ticker in step.

import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { nextDueTime, scheduleProblem, type Schedule } from "@/lib/automations/cron-schedule";
import {
  editAutomations,
  readAutomations,
  runsOf,
  type AutomationModel,
  type NotifyChannelTarget,
} from "@/lib/automations/store";
import { fireAutomation, syncAutomationsRuntime } from "@/lib/automations/runner";
import { readTelegramConfig } from "@/lib/telegram/config-store";

function asSchedule(raw: unknown): Schedule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.kind === "cron" && typeof record.expr === "string") {
    return { kind: "cron", expr: record.expr, ...(typeof record.tz === "string" && record.tz.trim() !== "" ? { tz: record.tz } : {}) };
  }
  if (record.kind === "at" && typeof record.atMs === "number" && Number.isFinite(record.atMs)) {
    return { kind: "at", atMs: record.atMs };
  }
  if (record.kind === "every" && typeof record.everyMs === "number" && Number.isFinite(record.everyMs)) {
    return { kind: "every", everyMs: record.everyMs };
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Notify targets off the wire: telegram targets with an integer chat id. */
function asNotifyChannels(raw: unknown): NotifyChannelTarget[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const targets: NotifyChannelTarget[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "telegram") continue;
    const chatId = record.chatId;
    if (typeof chatId !== "number" || !Number.isInteger(chatId) || seen.has(chatId)) continue;
    seen.add(chatId);
    targets.push({ type: "telegram", chatId });
  }
  return targets;
}

/** What the notify row's Telegram picklist shows: the channel's chats. */
function telegramPicklist(): { tokenSet: boolean; chats: { id: number; title: string | null }[] } {
  const config = readTelegramConfig();
  return {
    tokenSet: config.token !== "",
    chats: config.allowedChats.map((chat) => ({ id: chat.id, title: chat.title })),
  };
}

function validateDraft(body: Record<string, unknown>): { schedule?: Schedule; name?: string; cwd?: string; prompt?: string; problem?: string } {
  const name = asString(body.name);
  if (!name) return { problem: "A name is required." };
  const schedule = asSchedule(body.schedule);
  if (!schedule) return { problem: "A schedule is required." };
  const scheduleIssue = scheduleProblem(schedule);
  if (scheduleIssue) return { schedule, problem: `Invalid schedule: ${scheduleIssue}.` };
  const cwd = asString(body.cwd);
  if (!cwd) return { problem: "A working directory is required." };
  const prompt = asString(body.prompt);
  if (!prompt) return { problem: "A prompt is required." };
  return { schedule, name, cwd, prompt };
}

export async function GET() {
  try {
    const file = readAutomations();
    return NextResponse.json({ automations: file.automations, runs: runsOf(file), telegram: telegramPicklist() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let action: string | undefined;
  try {
    const body = await req.json() as { action?: unknown } & Record<string, unknown>;
    action = typeof body.action === "string" ? body.action : undefined;
    switch (action) {
      case "preview": {
        const schedule = asSchedule(body.schedule);
        if (!schedule) {
          return NextResponse.json({ error: "A schedule is required." }, { status: 400 });
        }
        const problem = scheduleProblem(schedule);
        if (problem) {
          return NextResponse.json({ dueAt: null, problem });
        }
        return NextResponse.json({ dueAt: nextDueTime(schedule, Date.now()), problem: null });
      }
      case "create": {
        const draft = validateDraft(body);
        if (draft.problem) return NextResponse.json({ error: draft.problem }, { status: 400 });
        const model = body.model as { provider?: unknown; modelId?: unknown } | undefined;
        const id = randomUUID();
        const automation: AutomationModel = {
          id,
          name: draft.name!,
          enabled: body.enabled === true,
          schedule: draft.schedule!,
          cwd: draft.cwd!,
          prompt: draft.prompt!,
          model: model && typeof model.provider === "string" && typeof model.modelId === "string"
            ? { provider: model.provider, modelId: model.modelId }
            : null,
          thinkingLevel: asString(body.thinkingLevel),
          notify: body.notify !== false,
          notifyChannels: asNotifyChannels(body.notifyChannels),
          nextDueAt: null,
          lastRunAt: null,
          createdAt: Date.now(),
        };
        await editAutomations((file) => ({
          file: { ...file, automations: [...file.automations, automation] },
          changed: true,
        }));
        syncAutomationsRuntime();
        return NextResponse.json({ success: true, automation });
      }
      case "update": {
        const id = asString(body.id);
        if (!id) return NextResponse.json({ error: "An id is required." }, { status: 400 });
        const draft = validateDraft(body);
        if (draft.problem) return NextResponse.json({ error: draft.problem }, { status: 400 });
        const model = body.model as { provider?: unknown; modelId?: unknown } | undefined;
        const patch = {
          name: draft.name!,
          schedule: draft.schedule!,
          cwd: draft.cwd!,
          prompt: draft.prompt!,
          notify: body.notify !== false,
          notifyChannels: asNotifyChannels(body.notifyChannels),
          ...(model && typeof model.provider === "string" && typeof model.modelId === "string"
            ? { model: { provider: model.provider, modelId: model.modelId } }
            : { model: null }),
          ...(asString(body.thinkingLevel) ? { thinkingLevel: asString(body.thinkingLevel) } : { thinkingLevel: null }),
        };
        let updated: AutomationModel | null = null;
        await editAutomations((file) => {
          let changed = false;
          const automations = file.automations.map((automation) => {
            if (automation.id !== id) return automation;
            changed = true;
            updated = { ...automation, ...patch, nextDueAt: null };
            return updated;
          });
          return { file: { ...file, automations }, changed };
        });
        if (!updated) return NextResponse.json({ error: "No such automation." }, { status: 404 });
        syncAutomationsRuntime();
        return NextResponse.json({ success: true, automation: updated });
      }
      case "delete": {
        const id = asString(body.id);
        if (!id) return NextResponse.json({ error: "An id is required." }, { status: 400 });
        await editAutomations((file) => ({
          file: {
            automations: file.automations.filter((automation) => automation.id !== id),
            runs: file.runs.filter((run) => run.automationId !== id),
          },
          changed: true,
        }));
        syncAutomationsRuntime();
        return NextResponse.json({ success: true });
      }
      case "set-enabled": {
        const id = asString(body.id);
        if (!id || typeof body.enabled !== "boolean") {
          return NextResponse.json({ error: "An id and enabled are required." }, { status: 400 });
        }
        await editAutomations((file) => {
          let changed = false;
          const automations = file.automations.map((automation) => {
            if (automation.id !== id) return automation;
            changed = true;
            return { ...automation, enabled: body.enabled === true, nextDueAt: null };
          });
          return { file: { ...file, automations }, changed };
        });
        syncAutomationsRuntime();
        return NextResponse.json({ success: true });
      }
      case "run-now": {
        const id = asString(body.id);
        if (!id) return NextResponse.json({ error: "An id is required." }, { status: 400 });
        const automation = readAutomations().automations.find((entry) => entry.id === id);
        if (!automation) return NextResponse.json({ error: "No such automation." }, { status: 404 });
        const running = readAutomations().runs.some((run) => run.automationId === id && run.status === "running");
        if (running) return NextResponse.json({ error: "A run is still going." }, { status: 409 });
        syncAutomationsRuntime();
        // Not awaited: the reply says it started; the history shows the rest.
        void fireAutomation(automation, "manual").catch(() => {});
        return NextResponse.json({ success: true, started: true });
      }
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
