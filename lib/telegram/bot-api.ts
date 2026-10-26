// A minimal Telegram Bot API client over fetch. No bot framework: pi-web's
// dependency tree stays as it is. The token is only ever placed in the URL
// path (how the Bot API authenticates) and in request bodies Telegram itself
// requires; callers must keep it out of logs and API responses.

const API_BASE = "https://api.telegram.org";
const FILE_BASE = "https://api.telegram.org/file/bot";

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    data?: string;
    message?: TelegramMessage;
  };
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string };
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
  text?: string;
  /** Photo sizes, smallest first; the last is the original resolution. */
  photo?: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }[];
  voice?: { file_id: string; mime_type?: string; duration?: number };
  caption?: string;
  reply_to_message?: TelegramMessage;
}

export interface InlineButton {
  text: string;
  callback_data: string;
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
    { offset, timeout: timeoutSeconds, allowed_updates: ["message", "edited_message", "callback_query"] },
    timeoutSeconds * 1000 + 15_000,
  );
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  options: { parseMode?: "HTML"; replyMarkup?: { inline_keyboard: InlineButton[][] }; replyToMessageId?: number } = {},
): Promise<TelegramMessage> {
  return call(token, "sendMessage", {
    chat_id: chatId,
    // Plain text unless a parseMode is given: Telegram's Markdown dialects
    // reject more than they accept, and a formatting error would drop the
    // whole reply.
    text,
    ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
    ...(options.replyToMessageId !== undefined ? { reply_to_message_id: options.replyToMessageId } : {}),
    ...(options.replyMarkup !== undefined ? { reply_markup: options.replyMarkup } : {}),
    link_preview_options: { is_disabled: true },
  });
}

export async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  options: { parseMode?: "HTML" } = {},
): Promise<void> {
  await call(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
    link_preview_options: { is_disabled: true },
  });
}

export async function deleteMessage(token: string, chatId: number, messageId: number): Promise<void> {
  await call(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

export async function answerCallbackQuery(token: string, callbackQueryId: string, text?: string): Promise<void> {
  await call(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
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

/** Downloads a file (photos, voice) by the file_id an update carried. */
export async function downloadFile(token: string, fileId: string): Promise<{ bytes: Buffer; mimeType: string | null }> {
  const file = await call<{ file_id: string; file_path?: string; file_size?: number }>(
    token,
    "getFile",
    { file_id: fileId },
  );
  if (!file.file_path) throw new TelegramApiError("Telegram returned no file_path", null, null);
  if ((file.file_size ?? 0) > 20 * 1024 * 1024) {
    throw new TelegramApiError("The file is over 20 MB", "too large", null);
  }
  const response = await fetch(`${FILE_BASE}${token}/${file.file_path}`, {
    signal: AbortSignal.timeout(60_000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new TelegramApiError(`Downloading the file failed: HTTP ${response.status}`, null, response.status);
  }
  const mimeType = response.headers.get("content-type");
  return { bytes: Buffer.from(await response.arrayBuffer()), mimeType };
}
