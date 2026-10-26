// The Telegram polling loop singleton: one long-poll loop per process, kept
// in step with the config file (token/enabled changes restart it through
// syncTelegramRuntime). Updates are handled one at a time in order: a long
// agent turn holds later messages of the same chat queued in pi itself. A
// non-allowlisted chat is never answered, only recorded for the pairing UI.

import {
  getUpdates,
  getMe,
  sendMessage,
  sendChatAction,
  setMyCommands,
  type TelegramUpdate,
} from "./bot-api";
import {
  editTelegramState,
  readTelegramConfig,
  readTelegramState,
  tokenHint,
  type TelegramConfig,
} from "./config-store";
import { resetChatSession, runChatTurn } from "./session-bridge";
import { splitForTelegram } from "./message-text";
import type { TelegramStatus } from "./types";
import { getRpcSession } from "@/lib/rpc-manager";

const POLL_TIMEOUT_SECONDS = 25;
const MAX_BACKOFF_MS = 60_000;

interface RuntimeInfo {
  running: boolean;
  botUsername: string | null;
  lastError: string | null;
  lastConnectedAt: number | null;
}

interface LoopHandle {
  cancelled: boolean;
}

// Route handlers are bundled separately and hot reload re-evaluates modules;
// globalThis keeps one runtime per process.
const STORE_KEY: symbol = Symbol.for("pi-web:telegram-runtime");
interface RuntimeGlobal {
  info: RuntimeInfo;
  loop: LoopHandle | null;
  configEpoch: number;
}
function runtime(): RuntimeGlobal {
  const store = globalThis as Record<symbol, RuntimeGlobal | undefined>;
  return (store[STORE_KEY] ??= { info: { running: false, botUsername: null, lastError: null, lastConnectedAt: null }, loop: null, configEpoch: 0 });
}

export function getTelegramStatus(): TelegramStatus {
  const config = readTelegramConfig();
  return {
    config: {
      tokenSet: config.token !== "",
      tokenHint: tokenHint(config.token),
      enabled: config.enabled,
      defaultCwd: config.defaultCwd,
      allowedChats: config.allowedChats,
    },
    running: runtime().info.running,
    botUsername: runtime().info.botUsername,
    lastError: runtime().info.lastError,
    lastConnectedAt: runtime().info.lastConnectedAt,
    lastUnknownChat: readTelegramState().lastUnknownChat,
  };
}

/** Starts or stops the loop to match the config on disk. */
export async function syncTelegramRuntime(): Promise<void> {
  const current = runtime();
  const config = readTelegramConfig();
  const shouldRun = config.token !== "" && config.enabled;
  current.configEpoch += 1;
  if (current.loop) current.loop.cancelled = true;
  current.loop = null;
  current.info.running = false;
  if (!shouldRun) {
    if (current.info.botUsername !== null || current.info.lastError !== null) {
      current.info = { running: false, botUsername: null, lastError: null, lastConnectedAt: current.info.lastConnectedAt };
    }
    return;
  }
  const loop: LoopHandle = { cancelled: false };
  current.loop = loop;
  void pollLoop(loop, config, current.configEpoch).catch((error) => {
    console.warn(`[pi-web] the telegram loop ended unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function pollLoop(loop: LoopHandle, config: TelegramConfig, epoch: number): Promise<void> {
  const current = runtime();
  const token = config.token;
  console.log(`[pi-web] telegram loop #${epoch} starting`);
  try {
    const me = await getMe(token);
    console.log(`[pi-web] telegram loop #${epoch}: getMe ok (@${me.username})`);
    current.info.botUsername = me.username;
    current.info.lastError = null;
    await registerCommands(token).catch(() => {});
    console.log(`[pi-web] telegram loop #${epoch}: commands registered`);
  } catch (error) {
    console.warn(`[pi-web] telegram loop #${epoch}: startup failed: ${error instanceof Error ? error.message : String(error)}`);
    current.info.running = false;
    current.info.lastError = error instanceof Error ? error.message : String(error);
    if (current.loop === loop) current.loop = null;
    return;
  }
  current.info.running = true;
  let failures = 0;
  while (!loop.cancelled && runtime().configEpoch === epoch) {
    let updates: TelegramUpdate[];
    try {
      const offset = readTelegramState().offset;
      updates = await getUpdates(token, offset, POLL_TIMEOUT_SECONDS);
      failures = 0;
      current.info.lastConnectedAt = Date.now();
      current.info.lastError = null;
    } catch (error) {
      failures += 1;
      current.info.lastError = error instanceof Error ? error.message : String(error);
      await sleep(Math.min(MAX_BACKOFF_MS, 500 * 2 ** failures));
      continue;
    }
    for (const update of updates) {
      if (loop.cancelled || runtime().configEpoch !== epoch) break;
      await persistOffset(update.update_id + 1);
      await handleUpdate(token, update);
    }
  }
  console.log(`[pi-web] telegram loop #${epoch}: exited (cancelled=${loop.cancelled}, epoch=${runtime().configEpoch})`);
  if (current.loop === loop) {
    current.loop = null;
    current.info.running = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The Telegram command menu, registered once per loop start (setMyCommands). */
const NATIVE_COMMANDS: { command: string; description: string }[] = [
  { command: "new", description: "Start a fresh session" },
  { command: "stop", description: "Stop the running turn" },
  { command: "status", description: "Is a turn running?" },
  { command: "help", description: "What this bot can do" },
];

async function registerCommands(token: string): Promise<void> {
  await setMyCommands(token, NATIVE_COMMANDS);
}

async function persistOffset(nextOffset: number): Promise<void> {
  await editTelegramState((state) => {
    if (state.offset >= nextOffset) return { state, changed: false };
    return { state: { ...state, offset: nextOffset }, changed: true };
  }).catch(() => {});
}

function isAllowed(config: TelegramConfig, chatId: number): boolean {
  return config.allowedChats.some((chat) => chat.id === chatId);
}

async function reply(token: string, chatId: number, text: string): Promise<void> {
  for (const chunk of splitForTelegram(text)) {
    try {
      await sendMessage(token, chatId, chunk);
    } catch (error) {
      console.warn(`[pi-web] telegram chat ${chatId}: sending a reply failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const HELP_TEXT = [
  "Pi Web is connected. Messages run in this chat's pi session; you can open it in the sidebar.",
  "/new — start a fresh session (the old one stays in the sidebar)",
  "/stop — stop the running turn",
  "/status — is a turn running?",
  "A message sent while a turn runs is queued as its follow-up.",
].join("\n");

/** The chats with a turn (or queued follow-up) still resolving, for /status. */
const inflightTurns = new Map<number, Promise<void>>();

function dispatchTurn(token: string, chatId: number, text: string): void {
  // Not awaited: pi queues a prompt sent mid-run as a follow-up turn, so the
  // polling loop stays free for /stop and other chats.
  const turn = (async () => {
    const config = readTelegramConfig();
    const outcome = await runChatTurn(chatId, text, config, () => sendChatAction(token, chatId));
    if (outcome.error) {
      await reply(token, chatId, `❌ ${outcome.error}`);
      return;
    }
    if (outcome.aborted) {
      await reply(token, chatId, outcome.reply.trim() !== "" ? outcome.reply : "⏹ Stopped.");
      return;
    }
    if (outcome.reply.trim() === "") {
      await reply(token, chatId, "✅ The turn finished without a text reply.");
      return;
    }
    await reply(token, chatId, outcome.reply);
  })().finally(() => {
    if (inflightTurns.get(chatId) === turn) inflightTurns.delete(chatId);
  });
  inflightTurns.set(chatId, turn);
}

async function handleUpdate(token: string, update: TelegramUpdate): Promise<void> {
  const message = update.message ?? update.edited_message;
  if (!message || typeof message.text !== "string" || message.text.trim() === "") return;
  const chatId = message.chat.id;
  const title = message.chat.title
    ?? (message.chat.username ? `@${message.chat.username}` : null)
    ?? ([message.chat.first_name, message.chat.last_name].filter(Boolean).join(" ") || null);
  // The allowlist and default cwd are read fresh per update: the loop's
  // captured config predates Settings edits, and an allowlisted-here chat
  // must never be ignored because the loop started before it was allowed.
  const config = readTelegramConfig();
  if (!isAllowed(config, chatId)) {
    // Never answer an unapproved chat; only surface it for the pairing UI.
    await editTelegramState((state) => ({
      state: { ...state, lastUnknownChat: { id: chatId, title, at: Date.now() } },
      changed: true,
    })).catch(() => {});
    return;
  }
  const text = message.text.trim();
  if (text === "/start" || text === "/help") {
    await reply(token, chatId, HELP_TEXT);
    return;
  }
  if (text === "/new") {
    const outcome = await resetChatSession(chatId, config);
    await reply(token, chatId, outcome.error ? `❌ ${outcome.error}` : "🆕 New session started. The old one stays in the sidebar.");
    return;
  }
  if (text === "/stop") {
    const binding = readTelegramState().chats[String(chatId)];
    const wrapper = binding ? getRpcSession(binding.sessionId) : undefined;
    if (!wrapper || !wrapper.isAlive() || !wrapper.isRunning()) {
      await reply(token, chatId, "💤 No turn is running.");
      return;
    }
    try {
      await wrapper.send({ type: "abort" });
      await reply(token, chatId, "⏹ Stopping…");
    } catch (error) {
      await reply(token, chatId, `❌ Stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  if (text === "/status") {
    const binding = readTelegramState().chats[String(chatId)];
    const running = inflightTurns.has(chatId)
      || (binding ? getRpcSession(binding.sessionId)?.isRunning() === true : false);
    const which = binding ? `Session ${binding.sessionId.slice(0, 8)} in ${running ? "a running turn" : "idle"}.` : "No session yet; send a message to start one.";
    await reply(token, chatId, running ? `⏳ ${which} Later messages queue as follow-ups.` : `💤 ${which}`);
    return;
  }
  if (text.startsWith("/")) {
    await reply(token, chatId, "Unknown command.\n\n" + HELP_TEXT);
    return;
  }
  if (inflightTurns.has(chatId)) {
    // The turn still resolving gets this message queued behind it by pi.
    await sendChatAction(token, chatId).catch(() => {});
  }
  dispatchTurn(token, chatId, text);
}
