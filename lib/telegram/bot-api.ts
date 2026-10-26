// A minimal Telegram Bot API client over fetch. No bot framework: pi-web's
// dependency tree stays as it is. The token is only ever placed in the URL
// path (how the Bot API authenticates) and in request bodies Telegram itself
// requires; callers must keep it out of logs and API responses.

const API_BASE = "https://api.telegram.org";

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string };
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
  text?: string;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    /** Telegram's ok:false description, when the API answered. */
    public readonly description: string | null,
    public readonly statusCode: number | null,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

async function call<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    // Never include the URL (it holds the token) in the message.
    throw new TelegramApiError(
      `Telegram ${method} failed: ${error instanceof Error ? error.message : String(error)}`,
      null,
      null,
    );
  }
  let payload: { ok?: boolean; result?: T; description?: string } = {};
  try {
    payload = await response.json() as typeof payload;
  } catch {
    // A non-JSON answer falls through to the status error below.
  }
  if (!response.ok || payload.ok === false) {
    throw new TelegramApiError(
      `Telegram ${method} failed: ${payload.description ?? `HTTP ${response.status}`}`,
      payload.description ?? null,
      response.status,
    );
  }
  return payload.result as T;
}

export async function getMe(token: string): Promise<{ id: number; username: string; first_name: string }> {
  return call(token, "getMe");
}

export async function getUpdates(
  token: string,
  offset: number,
  timeoutSeconds: number,
): Promise<TelegramUpdate[]> {
  // The long poll holds the connection for timeoutSeconds; give fetch a
  // margin beyond it so a slow-but-healthy poll is not aborted as an error.
  return call(
    token,
    "getUpdates",
    { offset, timeout: timeoutSeconds, allowed_updates: ["message", "edited_message"] },
    timeoutSeconds * 1000 + 15_000,
  );
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
): Promise<TelegramMessage> {
  return call(token, "sendMessage", {
    chat_id: chatId,
    // Plain text: Telegram's Markdown dialects reject more than they accept,
    // and a formatting error would drop the whole reply.
    text,
    link_preview_options: { is_disabled: true },
  });
}

export async function sendChatAction(token: string, chatId: number, action = "typing"): Promise<void> {
  await call(token, "sendChatAction", { chat_id: chatId, action });
}

/** Registers the chat's command menu (the "/" button's entries). */
export async function setMyCommands(
  token: string,
  commands: { command: string; description: string }[],
): Promise<void> {
  await call(token, "setMyCommands", { commands });
}
