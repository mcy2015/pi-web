// Routes one Telegram chat onto one pi session: the first message creates a
// session (in the chat's own cwd, the channel default, or the dated default),
// later ones reopen it, and /new swaps in a fresh session. The binding
// outlives the server: it is persisted in the telegram state store, and the
// wrapper registry keeps the process's AgentSession alive between messages.
//
// Turn lifecycle mirrors pi's queue: a prompt sent while a run is active is
// accepted and queued as a follow-up, so the polling loop never blocks on a
// run. Only the short session-open/bind/send-acceptance phase is serialized
// per chat (two rapid messages must not race each other into two sessions);
// the wait for the turn's end happens outside that gate.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { getRpcSession, startRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { defaultCwdPath } from "@/lib/default-cwd";
import { editTelegramState, readTelegramState, type TelegramConfig, type TelegramRuntimeState } from "./config-store";
import { agentMessageText } from "./message-text";

export interface TurnImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface TelegramUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
}

export interface TurnInput {
  text: string;
  images?: TurnImage[];
  /** Streaming preview: the assistant text accumulated so far. */
  onProgress?: (text: string) => void;
  /** A blocking extension dialog asking for a decision (approvals). */
  onUiRequest?: (request: TelegramUiRequest) => void;
}

export interface RunOutcome {
  /** The reply text to send back; empty when the turn produced no text. */
  reply: string;
  /** An internal failure the chat should see as an error notice. */
  error: string | null;
  sessionId: string | null;
  /** The turn was aborted (Stop) rather than finished on its own. */
  aborted: boolean;
}

// The per-chat setup gate. Module state is fine: a hot reload simply resets
// it, at worst letting two setups race once.
const chatGates = new Map<string, Promise<void>>();

async function withChatGate<T>(chatId: number, operation: () => Promise<T>): Promise<T> {
  const key = String(chatId);
  const previous = chatGates.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => gate);
  chatGates.set(key, tail);
  tail.catch(() => {}).then(() => {
    // The settled tail is no longer a barrier; drop it so the map stays small.
    if (chatGates.get(key) === tail) chatGates.delete(key);
  });
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
  }
}

/** A chat's own cwd first, the channel default next. */
function resolveCwd(config: TelegramConfig, chatId: number): string | null {
  const own = config.allowedChats.find((chat) => chat.id === chatId)?.cwd;
  if (own) return own;
  return config.defaultCwd;
}

async function makeCwd(path: string): Promise<string | null> {
  try {
    mkdirSync(path, { recursive: true });
    return path;
  } catch {
    return null;
  }
}

async function resolveSessionCwd(config: TelegramConfig, chatId: number): Promise<string | null> {
  const own = resolveCwd(config, chatId);
  if (own) return makeCwd(own);
  // The dated default directory, the same "Use default directory" the new
  // session bar offers. mkdir before pi sees it.
  return makeCwd(defaultCwdPath());
}

async function openBoundSession(
  state: TelegramRuntimeState,
  chatId: number,
  config: TelegramConfig,
): Promise<{ sessionId: string; sessionFile: string; kind: "new" | "reopened" } | { error: string }> {
  const binding = state.chats[String(chatId)];
  if (binding) {
    const alive = getRpcSession(binding.sessionId);
    if (alive?.isAlive()) {
      return { sessionId: binding.sessionId, sessionFile: alive.sessionFile, kind: "reopened" };
    }
    try {
      const { session } = await startRpcSession(binding.sessionId, binding.sessionFile, undefined);
      return { sessionId: binding.sessionId, sessionFile: session.sessionFile, kind: "reopened" };
    } catch (error) {
      // The bound session file is gone or unreadable: fall through to a new
      // session rather than dropping the chat.
      console.warn(`[pi-web] telegram chat ${chatId}: reopening ${binding.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const cwd = await resolveSessionCwd(config, chatId);
  if (!cwd) return { error: "The working directory could not be created." };
  const tempKey = `__telegram__${randomUUID()}`;
  try {
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd);
    return { sessionId: realSessionId, sessionFile: session.sessionFile, kind: "new" };
  } catch (error) {
    return { error: `Could not start a session: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function bindChat(chatId: number, sessionId: string, sessionFile: string): Promise<void> {
  await editTelegramState((state) => {
    const next: TelegramRuntimeState = {
      ...state,
      chats: { ...state.chats, [String(chatId)]: { sessionId, sessionFile } },
    };
    return { state: next, changed: true };
  }).catch((error) => {
    console.warn(`[pi-web] telegram chat ${chatId}: persisting its binding failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/**
 * Opens (or creates) the chat's session and hands its wrapper to `operation`.
 * The open/bind phase runs inside the chat's gate.
 */
export async function withChatWrapper<T>(
  chatId: number,
  config: TelegramConfig,
  operation: (wrapper: AgentSessionWrapper, sessionId: string) => Promise<T>,
): Promise<T | { error: string }> {
  return withChatGate(chatId, async () => {
    const opened = await openBoundSession(readTelegramState(), chatId, config);
    if ("error" in opened) return { error: opened.error };
    const { sessionId, sessionFile, kind } = opened;
    if (kind === "new") await bindChat(chatId, sessionId, sessionFile);
    const wrapper = getRpcSession(sessionId);
    if (!wrapper || !wrapper.isAlive()) {
      return { error: "The session is no longer running; send a message first." };
    }
    return await operation(wrapper, sessionId);
  });
}

class TurnError extends Error {}

/**
 * Sends `input` as the chat's next turn and resolves when the turn ends: with
 * the final assistant text, an error notice, or an abort. A prompt sent while
 * an earlier run is still active is queued by pi as a follow-up turn, so this
 * resolves only after that queued turn has run. `onTyping` fires periodically
 * meanwhile (the runtime keeps the chat's "typing…" indicator alive).
 */
export async function runChatTurn(
  chatId: number,
  input: TurnInput,
  config: TelegramConfig,
  onTyping: () => Promise<void>,
): Promise<RunOutcome> {
  // Phase 1, inside the chat's gate: open/bind the session, subscribe, and
  // hand the prompt to pi (acceptance; a queued prompt returns here while the
  // earlier run continues).
  let armed: {
    wrapper: AgentSessionWrapper;
    sessionId: string;
    awaitDone: Promise<{ reply: string; aborted: boolean }>;
    lastText: () => string;
  };
  try {
    armed = await withChatGate(chatId, async () => {
      const opened = await openBoundSession(readTelegramState(), chatId, config);
      if ("error" in opened) throw new TurnError(opened.error);
      const { sessionId, sessionFile, kind } = opened;
      if (kind === "new") await bindChat(chatId, sessionId, sessionFile);

      const wrapper = getRpcSession(sessionId);
      if (!wrapper || !wrapper.isAlive()) {
        throw new TurnError("The session is no longer running; send the message again.");
      }

      let lastAssistantText = "";
      let aborted = false;
      let settleDone!: () => void;
      let settleFailed!: (error: Error) => void;
      const done = new Promise<void>((resolve, reject) => {
        settleDone = resolve;
        settleFailed = reject;
      });
      const unsubscribe = wrapper.onEvent((event) => {
        if (event.type === "message_end") {
          const message = (event as { message?: { role?: string; content?: unknown } }).message;
          if (message && message.role === "assistant") {
            const extracted = agentMessageText(message as { role: string; content: unknown });
            if (extracted.trim() !== "") lastAssistantText = extracted;
          }
        } else if (event.type === "message_update") {
          // The streaming preview: pi's accumulated partial assistant text.
          const streamed = (event as { assistantMessageEvent?: { partial?: unknown } }).assistantMessageEvent?.partial;
          if (typeof streamed === "string" && streamed.trim() !== "") input.onProgress?.(streamed);
        } else if (event.type === "prompt_done") {
          if ((event as { aborted?: boolean }).aborted) aborted = true;
          settleDone();
        } else if (event.type === "prompt_error") {
          settleFailed(new Error((event as { errorMessage?: string }).errorMessage ?? "The turn failed"));
        } else if (event.type === "extension_ui_request") {
          const request = event as {
            id?: unknown; method?: unknown; title?: unknown; message?: unknown; options?: unknown;
          };
          if (
            typeof request.id === "string"
            && (request.method === "select" || request.method === "confirm"
              || request.method === "input" || request.method === "editor")
          ) {
            input.onUiRequest?.({
              id: request.id,
              method: request.method,
              title: typeof request.title === "string" ? request.title : "",
              message: typeof request.message === "string" ? request.message : undefined,
              options: Array.isArray(request.options) ? request.options.filter((o): o is string => typeof o === "string") : undefined,
            });
          }
        }
      });

      const turn = {
        wrapper,
        sessionId,
        awaitDone: (async () => {
          try {
            await wrapper.send({
              type: "prompt",
              message: input.text,
              ...(input.images?.length ? { images: input.images } : {}),
            });
            await done;
            return { reply: lastAssistantText, aborted } as const;
          } finally {
            unsubscribe();
          }
        })(),
        lastText: () => lastAssistantText,
      };
      return turn;
    });
  } catch (error) {
    if (error instanceof TurnError) {
      return { reply: "", error: error.message, sessionId: null, aborted: false };
    }
    return { reply: "", error: `The turn failed: ${error instanceof Error ? error.message : String(error)}`, sessionId: null, aborted: false };
  }

  // Phase 2, outside the gate: the typing heartbeat and the wait for pi's
  // prompt_done (or prompt_error) for this turn.
  const typingTimer = setInterval(() => {
    void onTyping().catch(() => {});
  }, 5_000);
  try {
    const settled = await armed.awaitDone;
    return { reply: settled.reply, error: null, sessionId: armed.sessionId, aborted: settled.aborted };
  } catch (error) {
    const partial = armed.lastText();
    return { reply: partial, error: `The turn failed: ${error instanceof Error ? error.message : String(error)}`, sessionId: armed.sessionId, aborted: false };
  } finally {
    clearInterval(typingTimer);
  }
}

/** Starts a fresh session for the chat, replacing any earlier binding. */
export async function resetChatSession(chatId: number, config: TelegramConfig): Promise<RunOutcome> {
  try {
    const opened = await withChatGate(chatId, async () => {
      const result = await openBoundSession({ ...readTelegramState(), chats: {} }, chatId, config);
      if ("error" in result) throw new TurnError(result.error);
      await bindChat(chatId, result.sessionId, result.sessionFile);
      return result;
    });
    return { reply: "", error: null, sessionId: opened.sessionId, aborted: false };
  } catch (error) {
    if (error instanceof TurnError) {
      return { reply: "", error: error.message, sessionId: null, aborted: false };
    }
    return { reply: "", error: `Could not start a session: ${error instanceof Error ? error.message : String(error)}`, sessionId: null, aborted: false };
  }
}
