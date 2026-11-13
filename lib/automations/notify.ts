// Announces a finished automation run to its notify channels — OpenClaw's
// "announce" delivery: each target (today a Telegram chat from the channel's
// allowlist) receives the run's full final reply, never a summary. Delivery
// is best effort: a missing token or an unreachable chat logs a warning and
// never fails the run it belongs to.

import { editTelegramState, readTelegramConfig } from "../telegram/config-store";
import { sendMarkdownText } from "../telegram/rich-send";
import { TelegramApiError } from "../telegram/bot-api";
import { appendBriefing, capBriefingText, type TelegramBriefing } from "../telegram/briefings";
import type { AutomationModel, RunStatus } from "./store";

export interface AutomationOutcome {
  /** done / failed / skipped (an aborted turn records skipped). */
  status: RunStatus;
  /** The run's display name ("task · MM-DD HH:mm"). */
  name: string;
  /** The turn's final assistant text; "" when the run produced none. */
  reply: string;
  /** Why a run failed or was skipped, shown to the channel. */
  error: string | null;
  /** The run's session file, so chat follow-ups can read the full run. */
  sessionFile: string | null;
  startedAt: number;
  durationMs: number;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function outcomeHeader(automation: AutomationModel, outcome: AutomationOutcome): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const started = new Date(outcome.startedAt);
  const stamp = `${pad(started.getMonth() + 1)}-${pad(started.getDate())} ${pad(started.getHours())}:${pad(started.getMinutes())}`;
  const duration = formatDuration(outcome.durationMs);
  if (outcome.status === "failed") {
    return `❌ ${automation.name} · failed · ${stamp} · ${duration}${outcome.error ? `\n${outcome.error}` : ""}`;
  }
  if (outcome.status === "skipped") {
    return `⚠️ ${automation.name} · stopped · ${stamp} · ${duration}${outcome.error ? `\n${outcome.error}` : ""}`;
  }
  return `✅ ${automation.name} · ${stamp} · ${duration}`;
}

/** Backoff between announce attempts. The Bot API path (this host reaches it
 * through a router-level proxy) drops for minutes at a time — evening
 * congestion — while an API 4xx answer (bad request, chat gone) never heals. */
const NOTIFY_RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000];

/** The wait before the next attempt, or null when the error is final. */
export function notifyRetryDelayMs(attempt: number, error: unknown): number | null {
  if (attempt >= NOTIFY_RETRY_DELAYS_MS.length) return null;
  if (error instanceof TelegramApiError) {
    const status = error.statusCode;
    // Only the API's own rejections are permanent; network failures carry null.
    if (status !== null && status !== 429 && status < 500) return null;
  }
  return NOTIFY_RETRY_DELAYS_MS[attempt];
}

/** The briefing record for one delivered announce (pushedText = header + reply, exactly what the chat saw). */
export function briefingFromOutcome(
  automation: AutomationModel,
  outcome: AutomationOutcome,
  pushedText: string,
  messageIds: number[],
  at = Date.now(),
): TelegramBriefing {
  return {
    at,
    automationId: automation.id,
    name: outcome.name,
    // A terminal status only; a run somehow still "running" reads as stopped.
    status: outcome.status === "running" ? "skipped" : outcome.status,
    replyText: capBriefingText(pushedText),
    sessionFile: outcome.sessionFile,
    messageIds,
    deliveredAt: null,
  };
}

/** Records a delivered announce for the chat; a locked store only warns — the
 * announce itself was already sent, so a lost record must never fail the run
 * or the remaining targets. */
async function recordBriefing(
  chatId: number,
  automation: AutomationModel,
  outcome: AutomationOutcome,
  pushedText: string,
  messageIds: number[],
): Promise<void> {
  await editTelegramState((current) => ({
    state: appendBriefing(current, chatId, briefingFromOutcome(automation, outcome, pushedText, messageIds)),
    changed: true,
  }));
}

/** Delivers the outcome to every notify channel; never throws. */
export async function pushRunOutcome(automation: AutomationModel, outcome: AutomationOutcome): Promise<void> {
  const targets = automation.notifyChannels;
  if (targets.length === 0) return;
  const config = readTelegramConfig();
  if (config.token === "") {
    console.warn(`[pi-web] automation "${automation.name}": Telegram notify channels are set but the channel has no token`);
    return;
  }
  const text = outcome.reply.trim() !== ""
    ? `${outcomeHeader(automation, outcome)}\n\n${outcome.reply.trim()}`
    : outcomeHeader(automation, outcome);
  for (const target of targets) {
    if (target.type !== "telegram") continue;
    const attempts = NOTIFY_RETRY_DELAYS_MS.length + 1;
    let sentMessageIds: number[] | null = null;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          // Rich when the reply holds a table (Telegram renders it), else chunks.
          sentMessageIds = await sendMarkdownText(config.token, target.chatId, text);
          break;
        } catch (error) {
          const delay = notifyRetryDelayMs(attempt, error);
          if (delay === null) throw error;
          console.warn(
            `[pi-web] automation "${automation.name}": notifying telegram chat ${target.chatId} failed (attempt ${attempt + 1}/${attempts}), retrying in ${Math.round(delay / 1000)}s: ${error instanceof Error ? error.message : String(error)}`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    } catch (error) {
      console.warn(`[pi-web] automation "${automation.name}": notifying telegram chat ${target.chatId} failed: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    if (sentMessageIds !== null) {
      await recordBriefing(target.chatId, automation, outcome, text, sentMessageIds).catch((error) => {
        console.warn(`[pi-web] automation "${automation.name}": recording the briefing for telegram chat ${target.chatId} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}
