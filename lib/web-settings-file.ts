import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { serializeByKey } from "./key-serializer";

// pi-web's own settings, `pi-web-settings.json` beside pi's files in the agent
// dir. Unlike the sidebar state (`lib/session-ui-state.ts`) this holds server
// behaviour every client shares, so it is read at the moment it governs (a run
// completing), not cached: absent keys are the defaults, writes are serialized
// in-process, locked against other processes and replaced atomically, and a
// file that cannot be parsed reads as the defaults (the next write repairs it)
// instead of refusing every write the way pi's own settings.json does.

/** The settings file's shape; unknown keys of a valid file are kept on write. */
export interface WebSettings {
  autoNameSessions?: boolean;
}

// Route handlers are bundled separately and hot reload re-evaluates modules;
// globalThis keeps one queue per process.
const QUEUE_KEY: symbol = Symbol.for("pi-web:web-settings-write-queue");

// As `lib/session-ui-state.ts`'s lock: a compromised lock logged, never thrown —
// proper-lockfile's default throws from a timer, which would take the whole
// server down.
const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
  onCompromised: (error: Error) => {
    console.warn(`[pi-web] the web settings lock was compromised: ${error.message}`);
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getWebSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-settings.json");
}

/** Missing file reads as `{}`; a file that cannot be parsed (or is not an object) reads as `{}` with a warning. */
function parseSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.warn(`[pi-web] ${path} could not be parsed (${error instanceof Error ? error.message : String(error)}); using the default web settings`);
    return {};
  }
  if (!isRecord(parsed)) {
    console.warn(`[pi-web] ${path} is not a settings object; using the default web settings`);
    return {};
  }
  return parsed;
}

function toWebSettings(raw: Record<string, unknown>): WebSettings {
  return typeof raw.autoNameSessions === "boolean" ? { autoNameSessions: raw.autoNameSessions } : {};
}

/** Reads the settings without a lock: writes replace the file atomically, so a read never sees half of one. */
export function readWebSettings(path = getWebSettingsPath()): WebSettings {
  return toWebSettings(parseSettings(path));
}

/** Off is written explicitly; on removes the key, and on with no file creates nothing. */
export function writeAutoNameSessionsEnabled(enabled: boolean, path = getWebSettingsPath()): Promise<boolean> {
  return serializeByKey(QUEUE_KEY, path, async () => {
    mkdirSync(dirname(path), { recursive: true });
    const release = await lockfile.lock(path, LOCK_OPTIONS);
    try {
      // Existence is read under the lock, like the parse beside it: another
      // pi-web process may have written between an outside check and this one.
      const existed = existsSync(path);
      const raw = parseSettings(path);
      if (enabled) delete raw.autoNameSessions;
      else raw.autoNameSessions = false;
      if (enabled && !existed && Object.keys(raw).length === 0) return true;
      writePrivateFileAtomicSync(path, `${JSON.stringify(raw, null, 2)}\n`);
      return resolveAutoNameSessions(readWebSettings(path));
    } finally {
      await release();
    }
  });
}

/** The `autoNameSessions` rule: on unless explicitly turned off. */
export function resolveAutoNameSessions(settings: WebSettings): boolean {
  return settings.autoNameSessions !== false;
}

/** Reads the `autoNameSessions` setting as resolved for a completing run. */
export function readAutoNameSessionsEnabled(path = getWebSettingsPath()): boolean {
  return resolveAutoNameSessions(readWebSettings(path));
}
