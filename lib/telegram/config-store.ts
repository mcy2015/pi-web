// pi-web-telegram.json: the Telegram channel's user config (token, enabled,
// default cwd, allowlisted chats) and pi-web-telegram-state.json: the runtime
// state (poll offset, chat→session bindings, the last unknown chat for the
// pairing UI). Both follow the session UI state's rules: writes serialized
// per process, locked against others, replaced atomically, and a file that
// cannot be parsed is set aside, never overwritten. The config file holds
// the bot token, so it is created with owner-only permissions.

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { serializeByKey } from "../key-serializer";
import { readRegularFileText } from "../regular-file";
import type { TelegramAllowedChat } from "./types";

const MAX_BYTES = 1024 * 1024;

const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
  onCompromised: (error: Error) => {
    console.warn(`[pi-web] the telegram store lock was compromised: ${error.message}`);
  },
};

export class TelegramStoreLockedError extends Error {
  constructor(message = "Another process holds the telegram store lock") {
    super(message);
    this.name = "TelegramStoreLockedError";
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : null;
}

export interface TelegramConfig {
  /** Bot token from @BotFather. Stored locally only; never returned whole. */
  token: string;
  enabled: boolean;
  /** Where new chat sessions run; null falls back to the dated default cwd. */
  defaultCwd: string | null;
  allowedChats: TelegramAllowedChat[];
}

export interface TelegramChatBinding {
  sessionId: string;
  sessionFile: string;
}

export interface TelegramRuntimeState {
  /** The next getUpdates offset; 0 before the first batch. */
  offset: number;
  /** Chat id (as string, for JSON keys) → its pi session. */
  chats: Record<string, TelegramChatBinding>;
  lastUnknownChat: { id: number; title: string | null; at: number } | null;
}

export const EMPTY_CONFIG: TelegramConfig = { token: "", enabled: false, defaultCwd: null, allowedChats: [] };
export const EMPTY_STATE: TelegramRuntimeState = { offset: 0, chats: {}, lastUnknownChat: null };

export function telegramConfigPath(agentDir = getAgentDir()): string {
  return `${agentDir}/pi-web-telegram.json`;
}

export function telegramStatePath(agentDir = getAgentDir()): string {
  return `${agentDir}/pi-web-telegram-state.json`;
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
  // The rename replaces any earlier file; permissions only apply at creation,
  // so an existing world-readable file is tightened here too.
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
      if (errorCode(error) === "ELOCKED") throw new TelegramStoreLockedError();
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

const CONFIG_QUEUE: symbol = Symbol.for("pi-web:telegram-config-queue");
const STATE_QUEUE: symbol = Symbol.for("pi-web:telegram-state-queue");

export function parseConfig(raw: Record<string, unknown> | null): TelegramConfig {
  if (raw === null) return { ...EMPTY_CONFIG };
  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  const defaultCwd = typeof raw.defaultCwd === "string" && raw.defaultCwd.trim() !== "" ? raw.defaultCwd : null;
  const allowedChats: TelegramAllowedChat[] = Array.isArray(raw.allowedChats)
    ? raw.allowedChats.flatMap((entry): TelegramAllowedChat[] => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
        const id = (entry as { id?: unknown }).id;
        const title = (entry as { title?: unknown }).title;
        if (typeof id !== "number" || !Number.isInteger(id)) return [];
        return [{ id, title: typeof title === "string" && title.trim() !== "" ? title : null }];
      })
    : [];
  return { token, enabled: raw.enabled === true, defaultCwd, allowedChats };
}

export function readTelegramConfig(path = telegramConfigPath()): TelegramConfig {
  return parseConfig(readJson(path));
}

export function readTelegramState(path = telegramStatePath()): TelegramRuntimeState {
  const raw = readJson(path);
  if (raw === null) return { ...EMPTY_STATE, chats: {} };
  const offset = typeof raw.offset === "number" && Number.isInteger(raw.offset) && raw.offset >= 0 ? raw.offset : 0;
  const chats: Record<string, TelegramChatBinding> = {};
  if (typeof raw.chats === "object" && raw.chats !== null && !Array.isArray(raw.chats)) {
    for (const [key, value] of Object.entries(raw.chats)) {
      if (!/^-?\d+$/.test(key) || typeof value !== "object" || value === null) continue;
      const sessionId = (value as { sessionId?: unknown }).sessionId;
      const sessionFile = (value as { sessionFile?: unknown }).sessionFile;
      if (typeof sessionId === "string" && typeof sessionFile === "string" && sessionId !== "") {
        chats[key] = { sessionId, sessionFile };
      }
    }
  }
  const unknownRaw = raw.lastUnknownChat;
  const lastUnknownChat = typeof unknownRaw === "object" && unknownRaw !== null
    && typeof (unknownRaw as { id?: unknown }).id === "number"
    ? {
        id: (unknownRaw as { id: number }).id,
        title: typeof (unknownRaw as { title?: unknown }).title === "string" ? (unknownRaw as { title: string }).title : null,
        at: typeof (unknownRaw as { at?: unknown }).at === "number" ? (unknownRaw as { at: number }).at : 0,
      }
    : null;
  return { offset, chats, lastUnknownChat };
}

/** Read-modify-write the config under the lock. */
export function editTelegramConfig(
  edit: (config: TelegramConfig) => { config: TelegramConfig; changed: boolean },
  path = telegramConfigPath(),
): Promise<TelegramConfig> {
  return editFile(CONFIG_QUEUE, path, () => readTelegramConfig(path), (current) => {
    const result = edit(current);
    return { value: result.config, changed: result.changed };
  }, (config) => {
    writeJsonAtomic(path, config);
  });
}

/** Read-modify-write the runtime state under the lock. */
export function editTelegramState(
  edit: (state: TelegramRuntimeState) => { state: TelegramRuntimeState; changed: boolean },
  path = telegramStatePath(),
): Promise<TelegramRuntimeState> {
  return editFile(STATE_QUEUE, path, () => readTelegramState(path), (current) => {
    const result = edit(current);
    return { value: result.state, changed: result.changed };
  }, (state) => {
    writeJsonAtomic(path, state);
  });
}

/** The token's display hint: its last 4 characters. */
export function tokenHint(token: string): string | null {
  if (token.length < 8) return null;
  return token.slice(-4);
}
