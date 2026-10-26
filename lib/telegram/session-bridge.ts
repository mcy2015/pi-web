// Routes one Telegram chat onto one pi session: the first message creates a
// session (in the configured default cwd), later ones reopen it, and /new
// swaps in a fresh session. The binding outlives the server: it is persisted
// in the telegram state store, and the wrapper registry keeps the process's
// AgentSession alive between messages.

import { randomUUID } from "node:crypto";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { defaultCwdPath } from "@/lib/default-cwd";
import { mkdirSync } from "node:fs";
import { editTelegramState, readTelegramState, type TelegramConfig, type TelegramRuntimeState } from "./config-store";
import { agentMessageText } from "./message-text";

interface RunOutcome {
  /** The reply text to send back; empty when the turn produced no text. */
  reply: string;
  /** An internal failure the chat should see as an error notice. */
  error: string | null;
  sessionId: string | null;
}

async function resolveCwd(config: TelegramConfig): Promise<string | null> {
  if (config.defaultCwd) {
    try {
      mkdirSync(config.defaultCwd, { recursive: true });
      return config.defaultCwd;
    } catch {
      return null;
    }
  }
  // The dated default directory, the same "Use default directory" the new
  // session bar offers. mkdir before pi sees it.
  const dated = defaultCwdPath();
  try {
    mkdirSync(dated, { recursive: true });
    return dated;
  } catch {
    return null;
  }
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
  const cwd = await resolveCwd(config);
  if (!cwd) return { error: "The default working directory could not be created." };
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
 * Sends `text` as the chat's next turn and returns the final assistant text.
 * `onTyping` fires periodically while the turn runs (the runtime keeps the
 * chat's "typing…" indicator alive through it).
 */
export async function runChatTurn(
  chatId: number,
  text: string,
  config: TelegramConfig,
  onTyping: () => Promise<void>,
): Promise<RunOutcome> {
  const opened = await openBoundSession(readTelegramState(), chatId, config);
  if ("error" in opened) return { reply: "", error: opened.error, sessionId: null };
  const { sessionId, sessionFile, kind } = opened;
  if (kind === "new") await bindChat(chatId, sessionId, sessionFile);

  const wrapper = getRpcSession(sessionId);
  if (!wrapper || !wrapper.isAlive()) {
    return { reply: "", error: "The session is no longer running; send the message again.", sessionId };
  }

  let lastAssistantText = "";
  const unsubscribe = wrapper.onEvent((event) => {
    if (event.type !== "message_end") return;
    const message = (event as { message?: { role?: string; content?: unknown } }).message;
    if (!message || message.role !== "assistant") return;
    const extracted = agentMessageText(message as { role: string; content: unknown });
    if (extracted.trim() !== "") lastAssistantText = extracted;
  });

  const typingTimer = setInterval(() => {
    void onTyping().catch(() => {});
  }, 5_000);
  try {
    await wrapper.send({ type: "prompt", message: text });
    return { reply: lastAssistantText, error: null, sessionId };
  } catch (error) {
    return { reply: "", error: `The turn failed: ${error instanceof Error ? error.message : String(error)}`, sessionId };
  } finally {
    clearInterval(typingTimer);
    unsubscribe();
  }
}

/** Starts a fresh session for the chat, replacing any earlier binding. */
export async function resetChatSession(chatId: number, config: TelegramConfig): Promise<RunOutcome> {
  const opened = await openBoundSession({ ...readTelegramState(), chats: {} }, chatId, config);
  if ("error" in opened) return { reply: "", error: opened.error, sessionId: null };
  await bindChat(chatId, opened.sessionId, opened.sessionFile);
  return { reply: "", error: null, sessionId: opened.sessionId };
}
