// Pure schedule math for Automations, with no third-party cron dependency:
// a five-field cron expression in a timezone, a one-shot timestamp, or an
// interval. The next due time is computed in the schedule's wall clock
// (fast arithmetic) and only converted to an epoch through Intl formatters,
// so DST shifts resolve to the times the zone actually has.

export type CronSchedule = { kind: "cron"; expr: string; tz?: string };
export type AtSchedule = { kind: "at"; atMs: number };
export type EverySchedule = { kind: "every"; everyMs: number };
export type Schedule = CronSchedule | AtSchedule | EverySchedule;

const MINUTE_MS = 60_000;
/** How far ahead a cron expression may next match: leap years cycle in 4. */
const CRON_SEARCH_WALL_MINUTES = 4 * 366 * 24 * 60;

interface Wall {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  dow: number; // 0-6, Sunday 0 (cron's numbering)
}

interface CronField {
  values: ReadonlySet<number>;
  unrestricted: boolean;
}

export interface ParsedCron {
  minutes: CronField;
  hours: CronField;
  doms: CronField;
  months: CronField;
  dows: CronField;
}

/** A field's syntax: `*`, numbers, ranges `a-b`, lists `a,b-c`, steps (`x`/n), `a-b`/n. */
function parseField(text: string, min: number, max: number): CronField | null {
  const values = new Set<number>();
  let unrestricted = false;
  for (const part of text.split(",")) {
    if (part === "") return null;
    const stepMatch = part.match(/^(.+?)(?:\/(\d+))?$/);
    if (!stepMatch) return null;
    const rangeText = stepMatch[1];
    const step = stepMatch[2] !== undefined ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let from: number;
    let to: number;
    if (rangeText === "*") {
      from = min;
      to = max;
      if (step === 1) unrestricted = true;
    } else {
      const range = rangeText.match(/^(\d+)(?:-(\d+))?$/);
      if (!range) return null;
      from = Number(range[1]);
      to = range[2] !== undefined ? Number(range[2]) : from;
      if (from < min || to > max || from > to) return null;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  if (values.size === 0) return null;
  return { values, unrestricted };
}

/** Parses a five-field cron expression (minute hour dom month dow); null when invalid. */
export function parseCronExpr(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  const doms = parseField(fields[2], 1, 31);
  const months = parseField(fields[3], 1, 12);
  const dows = parseField(fields[4], 0, 6);
  if (!minutes || !hours || !doms || !months || !dows) return null;
  return { minutes, hours, doms, months, dows };
}

function wallMatches(parsed: ParsedCron, wall: Wall): boolean {
  if (!parsed.months.values.has(wall.month)) return false;
  const domRestricted = !parsed.doms.unrestricted;
  const dowRestricted = !parsed.dows.unrestricted;
  const domOk = parsed.doms.values.has(wall.day);
  const dowOk = parsed.dows.values.has(wall.dow);
  // Vixie cron: with both day fields restricted, either may match.
  if (domRestricted && dowRestricted) {
    if (!domOk && !dowOk) return false;
  } else if (domRestricted) {
    if (!domOk) return false;
  } else if (dowRestricted) {
    if (!dowOk) return false;
  }
  return parsed.hours.values.has(wall.hour) && parsed.minutes.values.has(wall.minute);
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const minuteFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(tz: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    });
    dayFormatters.set(tz, formatter);
  }
  return formatter;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function epochToWall(tz: string, ms: number): Wall | null {
  // The day formatter gives year/month/day/weekday; the minute formatter the
  // hour and minute. Kept as two formatters so each stays a small ICU object.
  const parts = dayFormatter(tz).formatToParts(new Date(ms));
  let minuteFormatter = minuteFormatters.get(tz);
  if (!minuteFormatter) {
    minuteFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    });
    minuteFormatters.set(tz, minuteFormatter);
  }
  const timeParts = minuteFormatter.formatToParts(new Date(ms));
  const get = (source: Intl.DateTimeFormatPart[], type: string): number =>
    Number(source.find((part) => part.type === type)?.value ?? "0");
  let hour = get(timeParts, "hour");
  if (hour === 24) hour = 0; // Some ICU builds say 24:00 for midnight, h23 aside.
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const dow = WEEKDAYS[weekday];
  if (dow === undefined) return null;
  return {
    year: get(parts, "year"),
    month: get(parts, "month"),
    day: get(parts, "day"),
    hour,
    minute: get(timeParts, "minute"),
    dow,
  };
}

/** Wall clock minutes since year 0 of the proleptic Gregorian calendar. */
function wallToMinutes(wall: Wall): number {
  // Days since 1970-01-01 from the civil date (Howard Hinnant's algorithm).
  const y = wall.month <= 2 ? wall.year - 1 : wall.year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const m = wall.month;
  const d = wall.day;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146097 + doe - 719468;
  return ((days * 24 + wall.hour) * 60 + wall.minute);
}

function minutesToWall(totalMinutes: number): Wall {
  const days = Math.floor(totalMinutes / 1440);
  const minuteOfDay = totalMinutes - days * 1440;
  // Civil date from days since epoch (Hinnant's civil_from_days).
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = m <= 2 ? y + 1 : y;
  // Weekday: 1970-01-01 was a Thursday (4).
  const dow = (((days % 7) + 7 + 4) % 7);
  return {
    year, month: m, day: d,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    dow,
  };
}

function wallToEpoch(tz: string, wall: Wall): number {
  // Guess treating the wall clock as UTC, then converge: the formatter says
  // which wall clock the guess really is, and the difference shifts the guess.
  // Two passes cover every real offset jump; ambiguous DST times land on the
  // second (later) occurrence, missing ones on the clock after the gap.
  let guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  for (let attempt = 0; attempt < 2; attempt++) {
    const actual = epochToWall(tz, guess);
    if (!actual) break;
    const deltaMinutes = wallToMinutes(wall) - wallToMinutes(actual);
    if (deltaMinutes === 0) break;
    guess += deltaMinutes * MINUTE_MS;
  }
  return guess;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The next time strictly after `fromMs` the schedule fires, or null when it
 * never fires again (a past one-shot, or a cron day that never exists).
 */
export function nextDueTime(schedule: Schedule, fromMs: number): number | null {
  if (schedule.kind === "at") {
    return schedule.atMs > fromMs ? schedule.atMs : null;
  }
  if (schedule.kind === "every") {
    if (!Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) return null;
    return fromMs - (fromMs % schedule.everyMs) + schedule.everyMs;
  }
  const parsed = parseCronExpr(schedule.expr);
  if (!parsed) return null;
  const tz = schedule.tz && schedule.tz.trim() !== "" ? schedule.tz : "UTC";
  if (!isValidTimeZone(tz)) return null;
  const startWall = epochToWall(tz, fromMs);
  if (!startWall) return null;
  let cursor = wallToMinutes(startWall) + 1;
  const limit = cursor + CRON_SEARCH_WALL_MINUTES;
  for (; cursor <= limit; cursor++) {
    if (wallMatches(parsed, minutesToWall(cursor))) {
      return wallToEpoch(tz, minutesToWall(cursor));
    }
  }
  return null;
}

/** Why a schedule is invalid, or null when it is well-formed. */
export function scheduleProblem(schedule: Schedule): string | null {
  if (schedule.kind === "at") {
    return Number.isFinite(schedule.atMs) ? null : "atMs must be a number";
  }
  if (schedule.kind === "every") {
    if (!Number.isFinite(schedule.everyMs) || schedule.everyMs < MINUTE_MS) {
      return "everyMs must be at least one minute";
    }
    return null;
  }
  const parsed = parseCronExpr(schedule.expr);
  if (!parsed) return "not a five-field cron expression";
  const tz = schedule.tz && schedule.tz.trim() !== "" ? schedule.tz : "UTC";
  return isValidTimeZone(tz) ? null : "unknown timezone";
}
