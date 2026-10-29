// pi-web-channels.json: the Channels settings' user config — one section per
// channel (today only Telegram: token, enabled, default cwd, allowlisted
// chats) — and pi-web-channels-state.json: the channels' runtime state (the
// Telegram poll offset, chat→session bindings, the last unknown chat for the
// pairing UI). Both follow the session UI state's rules: writes serialized
// per process, locked against others, replaced atomically, and a file that
// cannot be parsed is set aside, never overwritten. The config file holds
// the bot token, so it is created with owner-only permissions.
// A pre-channels pi-web-telegram.json (or -state.json) is migrated once.

import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { serializeByKey } from "../key-serializer";
import { readRegularFileText } from "../regular-file";
import type { TelegramAllowedChat } from "./types";
import type { ReplyMode } from "./prefs";

const MAX_BYTES = 1024 * 1024;

const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
  onCompromised: (error: Error) => {
    console.warn(`[pi-web] the channels store lock was compromised: ${error.message}`);
  },
};

export class TelegramStoreLockedError extends Error {
  constructor(message = "Another process holds the channels store lock") {
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
  /** Chat id (as string) → its reply granularity; absent entry = "stream". */
  replyModes?: Record<string, ReplyMode>;
}

export const EMPTY_CONFIG: TelegramConfig = { token: "", enabled: false, defaultCwd: null, allowedChats: [] };
export const EMPTY_STATE: TelegramRuntimeState = { offset: 0, chats: {}, lastUnknownChat: null };

export function channelsConfigPath(agentDir = getAgentDir()): string {
  return `${agentDir}/pi-web-channels.json`;
}

export function channelsStatePath(agentDir = getAgentDir()): string {
  return `${agentDir}/pi-web-channels-state.json`;
}

/** The pre-channels flat files, migrated once into the sections above. */
function legacyConfigPath(path: string): string {
  return path.replace(/pi-web-channels\.json$/, "pi-web-telegram.json");
}

function legacyStatePath(path: string): string {
  return path.replace(/pi-web-channels-state\.json$/, "pi-web-telegram-state.json");
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

function fileExists(path: string): boolean {
  return existsSync(path);
}

/**
 * The one-time move from the pre-channels flat files: the legacy telegram
 * values become the "telegram" section of the channels file, and the legacy
 * file is renamed aside so the migration never runs twice.
 */
function migrateLegacy(legacyPath: string, newPath: string): void {
  if (!fileExists(legacyPath) || fileExists(newPath)) return;
  const legacy = readJson(legacyPath);
  if (legacy === null) return;
  const section = legacy.telegram && typeof legacy.telegram === "object"
    ? (legacy.telegram as Record<string, unknown>)
    : legacy;
  const existing = readJson(newPath);
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  if (next.telegram === undefined) next.telegram = section;
  try {
    writeJsonAtomic(newPath, next);
    renameSync(legacyPath, `${legacyPath}.migrated-${Date.now()}`);
    console.warn(`[pi-web] migrated ${legacyPath} into ${newPath}`);
  } catch (error) {
    console.warn(`[pi-web] migrating ${legacyPath} into ${newPath} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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

export function parseTelegramConfig(raw: unknown): TelegramConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...EMPTY_CONFIG };
  const record = raw as Record<string, unknown>;
  const token = typeof record.token === "string" ? record.token.trim() : "";
  const defaultCwd = typeof record.defaultCwd === "string" && record.defaultCwd.trim() !== "" ? record.defaultCwd : null;
  const allowedChats: TelegramAllowedChat[] = Array.isArray(record.allowedChats)
    ? record.allowedChats.flatMap((entry): TelegramAllowedChat[] => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
        const id = (entry as { id?: unknown }).id;
        const title = (entry as { title?: unknown }).title;
        const cwd = (entry as { cwd?: unknown }).cwd;
        if (typeof id !== "number" || !Number.isInteger(id)) return [];
        return [{
          id,
          title: typeof title === "string" && title.trim() !== "" ? title : null,
          cwd: typeof cwd === "string" && cwd.trim() !== "" ? cwd : null,
        }];
      })
    : [];
  return { token, enabled: record.enabled === true, defaultCwd, allowedChats };
}

export function readTelegramConfig(path = channelsConfigPath()): TelegramConfig {
  migrateLegacy(legacyConfigPath(path), path);
  const raw = readJson(path);
  if (raw === null) return { ...EMPTY_CONFIG };
  return parseTelegramConfig(raw.telegram);
}

const REPLY_MODE_VALUES: ReadonlySet<string> = new Set(["stream", "final", "tools"]);

export function parseTelegramState(raw: unknown): TelegramRuntimeState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...EMPTY_STATE, chats: {} };
  const record = raw as Record<string, unknown>;
  const offset = typeof record.offset === "number" && Number.isInteger(record.offset) && record.offset >= 0 ? record.offset : 0;
  const chats: Record<string, TelegramChatBinding> = {};
  if (typeof record.chats === "object" && record.chats !== null && !Array.isArray(record.chats)) {
    for (const [key, value] of Object.entries(record.chats)) {
      if (!/^-?\d+$/.test(key) || typeof value !== "object" || value === null) continue;
      const sessionId = (value as { sessionId?: unknown }).sessionId;
      const sessionFile = (value as { sessionFile?: unknown }).sessionFile;
      if (typeof sessionId === "string" && typeof sessionFile === "string" && sessionId !== "") {
        chats[key] = { sessionId, sessionFile };
      }
    }
  }
  const unknownRaw = record.lastUnknownChat;
  const lastUnknownChat = typeof unknownRaw === "object" && unknownRaw !== null
    && typeof (unknownRaw as { id?: unknown }).id === "number"
    ? {
        id: (unknownRaw as { id: number }).id,
        title: typeof (unknownRaw as { title?: unknown }).title === "string" ? (unknownRaw as { title: string }).title : null,
        at: typeof (unknownRaw as { at?: unknown }).at === "number" ? (unknownRaw as { at: number }).at : 0,
      }
    : null;
  const replyModes: Record<string, ReplyMode> = {};
  if (typeof record.replyModes === "object" && record.replyModes !== null && !Array.isArray(record.replyModes)) {
    // Lenient like the chat bindings: numeric chat keys, the three modes only.
    for (const [key, value] of Object.entries(record.replyModes)) {
      if (/^-?\d+$/.test(key) && typeof value === "string" && REPLY_MODE_VALUES.has(value)) {
        replyModes[key] = value as ReplyMode;
      }
    }
  }
  return {
    offset,
    chats,
    lastUnknownChat,
    // An empty field stays absent, keeping EMPTY_STATE-shaped states clean.
    ...(Object.keys(replyModes).length > 0 ? { replyModes } : {}),
  };
}

export function readTelegramState(path = channelsStatePath()): TelegramRuntimeState {
  migrateLegacy(legacyStatePath(path), path);
  const raw = readJson(path);
  if (raw === null) return { ...EMPTY_STATE, chats: {} };
  return parseTelegramState(raw.telegram);
}

/** Read-modify-write the Telegram section under the lock. */
export function editTelegramConfig(
  edit: (config: TelegramConfig) => { config: TelegramConfig; changed: boolean },
  path = channelsConfigPath(),
): Promise<TelegramConfig> {
  return editFile(CONFIG_QUEUE, path, () => readTelegramConfig(path), (current) => {
    const result = edit(current);
    return { value: result.config, changed: result.changed };
  }, (config) => {
    const raw = readJson(path) ?? {};
    writeJsonAtomic(path, { ...raw, telegram: config });
  });
}

/** Read-modify-write the Telegram runtime state under the lock. */
export function editTelegramState(
  edit: (state: TelegramRuntimeState) => { state: TelegramRuntimeState; changed: boolean },
  path = channelsStatePath(),
): Promise<TelegramRuntimeState> {
  return editFile(STATE_QUEUE, path, () => readTelegramState(path), (current) => {
    const result = edit(current);
    return { value: result.state, changed: result.changed };
  }, (state) => {
    const raw = readJson(path) ?? {};
    writeJsonAtomic(path, { ...raw, telegram: state });
  });
}

/** The token's display hint: its last 4 characters. */
export function tokenHint(token: string): string | null {
  if (token.length < 8) return null;
  return token.slice(-4);
}
