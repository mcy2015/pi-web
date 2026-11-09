// Automation briefings pushed to a Telegram chat, as follow-up context: the
// announce in lib/automations/notify.ts is a one-way bot message the chat's
// pi session never sees, so a user asking "what did the briefing say" would
// make the model re-run the whole task. Every delivered announce is recorded
// here (chat-scoped, in the channels state file); the runtime then prefixes
// the chat's next dispatched turn with the briefings that turn has not seen,
// and a Telegram reply to an announce message quotes that briefing whatever
// its age. Pure functions only — state I/O stays in config-store.ts, the
// recording in notify.ts, the consumption in runtime.ts.

export interface TelegramBriefing {
  /** When the announce was delivered (ms epoch). */
  at: number;
  automationId: string;
  /** The run's display name ("task · MM-DD HH:mm"). */
  name: string;
  status: "done" | "failed" | "skipped";
  /** The text the chat actually received (header included), capped. */
  replyText: string;
  /** The run's session file; readable by the model for the full run. */
  sessionFile: string | null;
  /** Every announce message id (a chunked delivery sends several). */
  messageIds: number[];
  /** When a dispatched turn first quoted this briefing; null = not yet. */
  deliveredAt: number | null;
}

/** Briefings kept per chat. */
export const MAX_BRIEFINGS_PER_CHAT = 8;
/** Briefings kept across all chats — the state file has a 1 MB read cap. */
export const MAX_BRIEFINGS_TOTAL = 48;
/** Stored (and quoted) text per briefing. */
export const MAX_BRIEFING_TEXT_CHARS = 4_000;
/** Total quoting budget for one dispatched turn. */
export const MAX_BRIEFING_CONTEXT_CHARS = 8_000;

const TRUNCATION_NOTE = "\n[truncated — read the run session file for the full text]";

/** Caps a briefing's stored text. */
export function capBriefingText(text: string): string {
  if (text.length <= MAX_BRIEFING_TEXT_CHARS) return text;
  return `${text.slice(0, Math.max(0, MAX_BRIEFING_TEXT_CHARS - TRUNCATION_NOTE.length))}${TRUNCATION_NOTE}`;
}

const STATUS_VALUES: ReadonlySet<string> = new Set(["done", "failed", "skipped"]);

/**
 * Defensive parsing for the persisted state, in the lenient style of
 * parseTelegramState's chats: numeric chat keys, malformed entries dropped,
 * a non-object whole field ignored.
 */
export function parseBriefings(raw: unknown): Record<string, TelegramBriefing[]> {
  const briefings: Record<string, TelegramBriefing[]> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return briefings;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^-?\d+$/.test(key) || !Array.isArray(value)) continue;
    const list: TelegramBriefing[] = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const at = record.at;
      const automationId = record.automationId;
      const name = record.name;
      const status = record.status;
      const replyText = record.replyText;
      const sessionFile = record.sessionFile;
      const messageIds = record.messageIds;
      const deliveredAt = record.deliveredAt;
      if (typeof at !== "number" || !Number.isFinite(at)) continue;
      if (typeof automationId !== "string" || typeof name !== "string") continue;
      if (typeof status !== "string" || !STATUS_VALUES.has(status)) continue;
      if (typeof replyText !== "string") continue;
      if (typeof sessionFile !== "string" && sessionFile !== null) continue;
      if (!Array.isArray(messageIds) || !messageIds.every((id) => typeof id === "number" && Number.isInteger(id))) continue;
      if (typeof deliveredAt !== "number" && deliveredAt !== null) continue;
      list.push({ at, automationId, name, status: status as TelegramBriefing["status"], replyText, sessionFile, messageIds, deliveredAt });
    }
    if (list.length > 0) briefings[key] = list;
  }
  return briefings;
}

function totalBriefings(briefings: Record<string, TelegramBriefing[]>): number {
  return Object.values(briefings).reduce((count, list) => count + list.length, 0);
}

/**
 * Appends a delivered briefing: the chat keeps its newest MAX_PER_CHAT
 * entries, and the whole state keeps at most MAX_TOTAL (the globally oldest
 * entries go first), so the state file stays far below its read cap.
 */
export function appendBriefing<T extends { briefings?: Record<string, TelegramBriefing[]> }>(
  state: T,
  chatId: number,
  briefing: TelegramBriefing,
): T {
  const key = String(chatId);
  const briefings: Record<string, TelegramBriefing[]> = { ...(state.briefings ?? {}), [key]: [...(state.briefings?.[key] ?? []), briefing] };
  briefings[key] = briefings[key].slice(-MAX_BRIEFINGS_PER_CHAT);
  let total = totalBriefings(briefings);
  while (total > MAX_BRIEFINGS_TOTAL) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [listKey, list] of Object.entries(briefings)) {
      if (list.length > 0 && list[0].at < oldestAt) {
        oldestAt = list[0].at;
        oldestKey = listKey;
      }
    }
    if (oldestKey === null) break;
    const trimmed = briefings[oldestKey].slice(1);
    if (trimmed.length === 0) delete briefings[oldestKey];
    else briefings[oldestKey] = trimmed;
    total--;
  }
  return { ...state, briefings };
}

/** The briefing delivered as one of these message ids, if recorded. */
export function briefingByMessageId(list: readonly TelegramBriefing[], messageId: number): TelegramBriefing | undefined {
  return list.find((briefing) => briefing.messageIds.includes(messageId));
}

function statusGlyph(status: TelegramBriefing["status"]): string {
  if (status === "failed") return "❌";
  if (status === "skipped") return "⚠️";
  return "✅";
}

function renderEntry(briefing: TelegramBriefing, full: boolean, repliedTo: boolean): string {
  const lines = [
    `${statusGlyph(briefing.status)} ${briefing.name}${repliedTo ? " — the user's message replies to this briefing" : ""}`,
    full ? briefing.replyText : "(full text omitted for space — open the run session file)",
  ];
  if (briefing.sessionFile) lines.push(`Run session file: ${briefing.sessionFile}`);
  return lines.join("\n");
}

/**
 * The quoted context for one dispatched turn: `included` in chronological
 * order; the newest entries keep their full text within the budget, older
 * ones degrade to a pointer line.
 */
export function formatBriefings(included: readonly TelegramBriefing[], repliedTo: TelegramBriefing | undefined): string {
  const full = new Map<TelegramBriefing, boolean>();
  let budget = MAX_BRIEFING_CONTEXT_CHARS;
  for (let index = included.length - 1; index >= 0; index--) {
    const briefing = included[index];
    const cost = renderEntry(briefing, true, briefing === repliedTo).length;
    if (cost <= budget) {
      full.set(briefing, true);
      budget -= cost;
    } else {
      full.set(briefing, false);
      budget = Math.max(0, budget - 120);
    }
  }
  const header = included.length === 1 && included[0] === repliedTo
    ? "Automation briefing the user replied to (delivered to this chat by the Telegram channel):"
    : "Automation briefings delivered to this chat since the last turn that saw them (the user's message follows):";
  return [header, ...included.map((briefing) => renderEntry(briefing, full.get(briefing) === true, briefing === repliedTo))].join("\n\n");
}

/**
 * The briefings one dispatched turn should see — the one being replied to
 * (whatever its age) plus every not-yet-delivered one — and the state with
 * those stamped delivered. Returns the same state reference when there is
 * nothing to quote or only already-delivered briefings: the caller maps that
 * to a no-op write.
 */
export function takeTurnContext<T extends { briefings?: Record<string, TelegramBriefing[]> }>(
  state: T,
  chatId: number,
  replyToMessageId: number | undefined,
  now: number,
): { state: T; context: string } {
  const key = String(chatId);
  const list = state.briefings?.[key] ?? [];
  const repliedTo = replyToMessageId !== undefined ? briefingByMessageId(list, replyToMessageId) : undefined;
  const undelivered = list.filter((briefing) => briefing.deliveredAt === null).sort((a, b) => a.at - b.at);
  const included: TelegramBriefing[] = [];
  for (const briefing of [...(repliedTo !== undefined ? [repliedTo] : []), ...undelivered]) {
    if (!included.includes(briefing)) included.push(briefing);
  }
  if (included.length === 0) return { state, context: "" };
  if (!included.some((briefing) => briefing.deliveredAt === null)) {
    // Only an already-delivered briefing is quoted; nothing changes.
    return { state, context: formatBriefings(included, repliedTo) };
  }
  const stamped = new Map(included.map((briefing) => [briefing, { ...briefing, deliveredAt: briefing.deliveredAt ?? now }]));
  const nextList = list.map((briefing) => stamped.get(briefing) ?? briefing);
  return { state: { ...state, briefings: { ...(state.briefings ?? {}), [key]: nextList } }, context: formatBriefings(included, repliedTo) };
}
