// Reusable inline-keyboard menu scaffolding for the Telegram channel: the
// `m:` callback-data encoding the buttons carry, and a registry of pending
// menus (one per chat and kind) that resolves button presses. Pure logic with
// no Telegram calls, so later command phases (/reply, /project, /task) reuse
// it unchanged; bot-api's button type is the only import.

import type { InlineButton } from "./bot-api";

export type TelegramMenuKind = "model" | "think" | "reply" | "project" | "task";

/** The Cancel row every menu appends; option rows use their list index. */
export const MENU_CANCEL_INDEX = -1;

export function encodeMenuCallback(kind: TelegramMenuKind, token: string, index: number): string {
  return `m:${kind}:${token}:${index}`;
}

/**
 * The inverse of encodeMenuCallback: a strict `m:` prefix, exactly four
 * colon-separated parts, an integer index — anything else is null. An unknown
 * kind still parses (the registry lookup rejects it), so adding a kind later
 * needs no change here.
 */
export function parseMenuCallback(data: string): { kind: TelegramMenuKind; token: string; index: number } | null {
  if (!data.startsWith("m:")) return null;
  const parts = data.split(":");
  if (parts.length !== 4) return null;
  if (!/^-?\d+$/.test(parts[3])) return null;
  return { kind: parts[1] as TelegramMenuKind, token: parts[2], index: Number(parts[3]) };
}

export interface MenuOption {
  /** What applying the option means; its interpretation belongs to the menu kind. */
  id: string;
  /** The unmarked button text; the current option's marker is added when buttons are built. */
  label: string;
}

const MENU_TTL_MS = 10 * 60_000;
const MAX_PENDING_MENUS = 100;

/** A fresh menu token; it only has to stay unique among one chat's pending menus. */
export function newMenuToken(): string {
  return Math.random().toString(36).slice(2, 6);
}

/**
 * Pending menus, keyed by chat and kind: a fresh issue of the same kind
 * replaces the previous one (its token stops resolving, so a stale button
 * press answers "Expired" instead of acting on old data), and entries expire
 * on their own. The optional clock exists for tests.
 */
export class TelegramMenuRegistry {
  private readonly entries = new Map<string, { token: string; options: MenuOption[]; messageId: number; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  issue(chatId: number, kind: TelegramMenuKind, options: MenuOption[], messageId: number, token = newMenuToken()): string {
    this.entries.set(this.key(chatId, kind), { token, options, messageId, expiresAt: this.now() + MENU_TTL_MS });
    // Prune after inserting, so the cap is enforced on this very issue.
    this.prune();
    return token;
  }

  /** Consumes the pending menu only when the token matches and it has not expired. */
  take(chatId: number, kind: TelegramMenuKind, token: string): { options: MenuOption[]; messageId: number } | null {
    const key = this.key(chatId, kind);
    const entry = this.entries.get(key);
    if (!entry || entry.token !== token) return null;
    if (entry.expiresAt <= this.now()) {
      // An expired entry is dead even with the right token; drop it lazily.
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    return { options: entry.options, messageId: entry.messageId };
  }

  private key(chatId: number, kind: TelegramMenuKind): string {
    return `${chatId}:${kind}`;
  }

  /** Drop expired entries and keep the map bounded (insertion order = oldest first). */
  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size > MAX_PENDING_MENUS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

function truncateButtonText(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/**
 * One option per row (rows stay one line narrow on phones) plus a Cancel row
 * carrying the reserved index -1. Labels truncate at 60 characters; the menu
 * message lists the full labels, so a cut button stays understandable.
 * `currentId` marks the currently selected option with a ✅, mirroring the
 * web model selector's marker.
 */
export function buildMenuKeyboard(
  kind: TelegramMenuKind,
  token: string,
  options: MenuOption[],
  opts: { cancelLabel?: string; currentId?: string } = {},
): InlineButton[][] {
  const rows: InlineButton[][] = options.map((option, index) => [
    {
      text: truncateButtonText((opts.currentId !== undefined && option.id === opts.currentId ? "✅ " : "") + option.label),
      callback_data: encodeMenuCallback(kind, token, index),
    },
  ]);
  rows.push([{ text: opts.cancelLabel ?? "Cancel", callback_data: encodeMenuCallback(kind, token, MENU_CANCEL_INDEX) }]);
  return rows;
}
