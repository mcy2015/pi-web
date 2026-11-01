// Announces a finished automation run to its notify channels — OpenClaw's
// "announce" delivery: each target (today a Telegram chat from the channel's
// allowlist) receives the run's full final reply, never a summary. Delivery
// is best effort: a missing token or an unreachable chat logs a warning and
// never fails the run it belongs to.

import { readTelegramConfig } from "../telegram/config-store";
import { sendMarkdownText } from "../telegram/rich-send";
import { TelegramApiError } from "../telegram/bot-api";
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
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          // Rich when the reply holds a table (Telegram renders it), else chunks.
          await sendMarkdownText(config.token, target.chatId, text);
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
  }
}
