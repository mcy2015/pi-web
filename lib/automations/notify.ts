// Announces a finished automation run to its notify channels — OpenClaw's
// "announce" delivery: each target (today a Telegram chat from the channel's
// allowlist) receives the run's full final reply, never a summary. Delivery
// is best effort: a missing token or an unreachable chat logs a warning and
// never fails the run it belongs to.

import { sendMessage, TelegramApiError } from "../telegram/bot-api";
import { readTelegramConfig } from "../telegram/config-store";
import { splitForTelegram, markdownToTelegramHtml } from "../telegram/message-text";
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

/** One chunk as Telegram HTML, falling back to plain text when rejected. */
async function sendChunk(token: string, chatId: number, chunk: string): Promise<void> {
  try {
    await sendMessage(token, chatId, markdownToTelegramHtml(chunk), { parseMode: "HTML" });
  } catch (error) {
    if (error instanceof TelegramApiError && error.statusCode === 400) {
      await sendMessage(token, chatId, chunk);
      return;
    }
    throw error;
  }
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
    for (const chunk of splitForTelegram(text)) {
      try {
        await sendChunk(config.token, target.chatId, chunk);
      } catch (error) {
        console.warn(`[pi-web] automation "${automation.name}": notifying telegram chat ${target.chatId} failed: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
  }
}
