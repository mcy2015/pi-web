// The pi-btw extension (dbachelder fork) can save a finished side question
// & answer into the session as a custom message (`customType: "btw-note"`).
// This module reads that message's `details` payload for the native Q&A card;
// a payload it cannot parse falls back to the generic custom message view.

/** Custom messages of this type carry the side Q&A in their `details`. */
export const BTW_NOTE_CUSTOM_TYPE = "btw-note";

export interface BtwNoteUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

export interface BtwNote {
  question: string;
  answer: string;
  provider?: string;
  model?: string;
  api?: string;
  thinkingLevel?: string;
  timestamp?: number;
  usage?: BtwNoteUsage;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Reads a btw-note's `details`; null when the payload holds no Q&A to show. */
export function parseBtwNoteDetails(details: unknown): BtwNote | null {
  if (typeof details !== "object" || details === null) return null;
  const record = details as Record<string, unknown>;
  const question = typeof record.question === "string" ? record.question : "";
  const answer = typeof record.answer === "string" ? record.answer : "";
  if (question === "" && answer === "") return null;

  const usageRecord = typeof record.usage === "object" && record.usage !== null
    ? record.usage as Record<string, unknown>
    : undefined;
  const costRecord = usageRecord !== undefined && typeof usageRecord.cost === "object" && usageRecord.cost !== null
    ? usageRecord.cost as Record<string, unknown>
    : undefined;

  return {
    question,
    answer,
    provider: optionalString(record.provider),
    model: optionalString(record.model),
    api: optionalString(record.api),
    thinkingLevel: optionalString(record.thinkingLevel),
    timestamp: finiteNumber(record.timestamp),
    usage: usageRecord === undefined ? undefined : {
      input: finiteNumber(usageRecord.input),
      output: finiteNumber(usageRecord.output),
      cacheRead: finiteNumber(usageRecord.cacheRead),
      cacheWrite: finiteNumber(usageRecord.cacheWrite),
      reasoning: finiteNumber(usageRecord.reasoning),
      totalTokens: finiteNumber(usageRecord.totalTokens),
      cost: costRecord === undefined ? undefined : { total: finiteNumber(costRecord.total) },
    },
  };
}
