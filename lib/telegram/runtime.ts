// The Telegram polling loop singleton: one long-poll loop per process, kept
// in step with the config file (token/enabled changes restart it through
// syncTelegramRuntime). Updates are handled one at a time in order, but a
// turn is never awaited: pi queues it, the loop stays free, and replies (and
// their streaming previews) arrive asynchronously. A non-allowlisted chat is
// never answered, only recorded for the pairing UI. In groups the bot only
// answers messages that mention it or reply to it.

import {
  getUpdates,
  getMe,
  sendMessage,
  sendChatAction,
  setMyCommands,
  editMessageText,
  deleteMessage,
  answerCallbackQuery,
  downloadFile,
  TelegramApiError,
  type InlineButton,
  type TelegramUpdate,
  type TelegramMessage,
} from "./bot-api";
import {
  editTelegramState,
  readTelegramConfig,
  readTelegramState,
  tokenHint,
  type TelegramConfig,
} from "./config-store";
import { resetChatSession, runChatTurn, withChatWrapper, type TelegramUiRequest, type TurnImage, type TurnInput } from "./session-bridge";
import { handleModelCommand, handleThinkCommand, applyModelMenuSelection } from "./command-model";
import { handleReplyCommand, applyReplyMenuSelection } from "./command-reply";
import { handleProjectCommand, applyProjectMenuSelection } from "./command-project";
import { handleTaskCommand, applyTaskMenuSelection } from "./command-task";
import { classifyDocument, buildDocumentPrompt } from "./attachments";
import { readChatReplyMode, type ReplyMode } from "./prefs";
import { MENU_CANCEL_INDEX, parseMenuCallback, TelegramMenuRegistry } from "./menus";
import { markdownToTelegramHtml, TELEGRAM_MESSAGE_LIMIT } from "./message-text";
import { sendMarkdownText, finalizePreviewRich } from "./rich-send";
import type { TelegramStatus } from "./types";
import { getRpcSession } from "@/lib/rpc-manager";

const POLL_TIMEOUT_SECONDS = 25;
const MAX_BACKOFF_MS = 60_000;
const PREVIEW_EDIT_MIN_INTERVAL_MS = 1_500;

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
  // Startup retries: a transient fetch failure at getMe must not kill the
  // loop until the next manual resync.
  let started = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (loop.cancelled || runtime().configEpoch !== epoch) return;
    try {
      const me = await getMe(token);
      console.log(`[pi-web] telegram loop #${epoch}: getMe ok (@${me.username})`);
      current.info.botUsername = me.username;
      current.info.lastError = null;
      await registerCommands(token).catch(() => {});
      console.log(`[pi-web] telegram loop #${epoch}: commands registered`);
      started = true;
      break;
    } catch (error) {
      console.warn(`[pi-web] telegram loop #${epoch}: startup failed (attempt ${attempt + 1}): ${error instanceof Error ? error.message : String(error)}`);
      current.info.lastError = error instanceof Error ? error.message : String(error);
      await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
    }
  }
  if (!started) {
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
      try {
        await handleUpdate(token, update);
      } catch (error) {
        console.warn(`[pi-web] telegram: handling an update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
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
  { command: "model", description: "Switch the model" },
  { command: "think", description: "Set the thinking level" },
  { command: "reply", description: "Reply detail: stream, final, or tools" },
  { command: "project", description: "Switch this chat's folder" },
  { command: "task", description: "Switch to an earlier session" },
  { command: "name", description: "Name this chat's session" },
  { command: "compact", description: "Compact the session context" },
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
  try {
    // Table-carrying replies leave as one rich message; the rest as chunks.
    await sendMarkdownText(token, chatId, text);
  } catch (error) {
    console.warn(`[pi-web] telegram chat ${chatId}: sending a reply failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const HELP_TEXT = [
  "Pi Web is connected. Messages run in this chat's pi session; you can open it in the sidebar.",
  "/new — start a fresh session (the old one stays in the sidebar)",
  "/stop — stop the running turn",
  "/name <title> — name (or rename) the session",
  "/compact — compact the session context",
  "/status — is a turn running?",
  "/model — switch this chat's model",
  "/think — set the thinking level",
  "/reply — streaming, final-only, or with a tool digest",
  "/project — switch this chat's working folder",
  "/task — switch to an earlier session in this folder",
  "Photos run with vision; small text files are read into the prompt. A message sent while a turn runs is queued as its follow-up.",
  "In groups I only answer messages that mention me or reply to me.",
].join("\n");

/** The chats with a turn (or queued follow-up) still resolving, for /status. */
const inflightTurns = new Map<number, Promise<void>>();

// ---- Streaming preview: one message per chat, edited in place, throttled. ----

interface ChatPreview {
  messageId: number | null;
  lastEditAt: number;
  lastLen: number;
}
const previews = new Map<number, ChatPreview>();

function previewOf(chatId: number): ChatPreview {
  let preview = previews.get(chatId);
  if (!preview) {
    preview = { messageId: null, lastEditAt: 0, lastLen: 0 };
    previews.set(chatId, preview);
  }
  return preview;
}

async function ensurePreviewMessage(token: string, chatId: number, text: string): Promise<void> {
  const preview = previewOf(chatId);
  if (preview.messageId !== null) return;
  try {
    const sent = await sendMessage(token, chatId, text);
    preview.messageId = sent.message_id;
    preview.lastEditAt = Date.now();
    preview.lastLen = text.length;
  } catch (error) {
    console.warn(`[pi-web] telegram chat ${chatId}: starting the preview failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function editPreview(token: string, chatId: number, text: string): Promise<void> {
  const preview = previewOf(chatId);
  if (preview.messageId === null) return;
  try {
    await editMessageText(token, chatId, preview.messageId, markdownToTelegramHtml(text), { parseMode: "HTML" });
    preview.lastEditAt = Date.now();
    preview.lastLen = text.length;
  } catch (error) {
    if (error instanceof TelegramApiError && error.statusCode === 400) {
      // Ill-formed HTML (or a tag split by truncation): the plain text still
      // shows the content; the next edit or the final reply replaces it.
      try {
        await editMessageText(token, chatId, preview.messageId, text);
        preview.lastEditAt = Date.now();
        preview.lastLen = text.length;
      } catch {
        // Leave the previous preview; the final reply still arrives.
      }
      return;
    }
    console.warn(`[pi-web] telegram chat ${chatId}: editing the preview failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function previewWantsEdit(preview: ChatPreview, text: string, now = Date.now()): boolean {
  if (now - preview.lastEditAt < PREVIEW_EDIT_MIN_INTERVAL_MS) return false;
  // Only for meaningfully longer text: Telegram rate limits edits hard.
  return text.length - preview.lastLen >= 40 || (text.length < 200 && text !== "" && preview.lastLen === 0);
}

// ---- Inline-button approvals: blocking extension dialogs become buttons. ----

interface PendingUi {
  chatId: number;
  kind: "select" | "confirm";
  options?: string[];
  messageId: number;
}
const pendingUi = new Map<string, PendingUi>();

// The pending inline menus (/model, /think, /reply, /project, /task): one
// per chat and kind, replaced by every fresh issue and expiring on their
// own, so a stale button press never acts on old data.
const menuRegistry = new TelegramMenuRegistry();

function buttonsFor(request: TelegramUiRequest): InlineButton[][] {
  if (request.method === "confirm") {
    return [
      [
        { text: "✅ Confirm", callback_data: `ui:${request.id}:y` },
        { text: "❌ Cancel", callback_data: `ui:${request.id}:n` },
      ],
    ];
  }
  return (request.options ?? []).slice(0, 8).map((option, index) => [
    { text: option.length > 60 ? `${option.slice(0, 57)}…` : option, callback_data: `ui:${request.id}:${index}` },
  ]);
}

async function offerUiRequest(token: string, chatId: number, request: TelegramUiRequest): Promise<void> {
  if (request.method === "input" || request.method === "editor") {
    // No keyboard path for free text: the browser session can still answer.
    await reply(token, chatId, `⌨️ ${request.title}\nThe turn is waiting for typed input — answer it in the Pi Web session (it is in the sidebar).`);
    return;
  }
  const text = request.method === "confirm"
    ? `⚠️ ${request.title}${request.message ? `\n${request.message}` : ""}`
    : `❓ ${request.title}`;
  try {
    const sent = await sendMessage(token, chatId, text, { replyMarkup: { inline_keyboard: buttonsFor(request) } });
    pendingUi.set(request.id, {
      chatId,
      kind: request.method as "select" | "confirm",
      options: request.options,
      messageId: sent.message_id,
    });
  } catch (error) {
    console.warn(`[pi-web] telegram chat ${chatId}: offering an approval failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleCallbackQuery(token: string, callbackQuery: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  const data = callbackQuery.data ?? "";
  if (data.startsWith("m:")) {
    await handleMenuCallback(token, callbackQuery);
    return;
  }
  if (!data.startsWith("ui:")) {
    await answerCallbackQuery(token, callbackQuery.id).catch(() => {});
    return;
  }
  const [, requestId, choice] = data.split(":");
  const pending = pendingUi.get(requestId);
  const chatId = pending?.chatId ?? callbackQuery.message?.chat.id;
  if (!pending || chatId === undefined) {
    await answerCallbackQuery(token, callbackQuery.id, "Expired").catch(() => {});
    return;
  }
  const binding = readTelegramState().chats[String(pending.chatId)];
  const wrapper = binding ? getRpcSession(binding.sessionId) : undefined;
  if (!wrapper || !wrapper.isAlive()) {
    await answerCallbackQuery(token, callbackQuery.id, "Session gone").catch(() => {});
    return;
  }
  let chosenLabel = "";
  try {
    if (pending.kind === "confirm") {
      const confirmed = choice === "y";
      chosenLabel = confirmed ? "✅ Confirmed" : "❌ Cancelled";
      await wrapper.send({ type: "extension_ui_response", id: requestId, confirmed });
    } else {
      const option = pending.options?.[Number(choice)];
      if (option === undefined) throw new Error("No such option");
      chosenLabel = option;
      await wrapper.send({ type: "extension_ui_response", id: requestId, value: option });
    }
  } catch (error) {
    console.warn(`[pi-web] telegram chat ${pending.chatId}: answering an approval failed: ${error instanceof Error ? error.message : String(error)}`);
    await answerCallbackQuery(token, callbackQuery.id, "Failed").catch(() => {});
    return;
  }
  pendingUi.delete(requestId);
  await answerCallbackQuery(token, callbackQuery.id, "✓").catch(() => {});
  await editMessageText(token, pending.chatId, pending.messageId, `✓ Chosen: ${chosenLabel}`).catch(() => {});
}

// ---- Inline menus (/model, /think, /reply, /project, /task): a pressed button applies its stored option. ----

async function handleMenuCallback(token: string, callbackQuery: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  const parsed = parseMenuCallback(callbackQuery.data ?? "");
  const chatId = callbackQuery.message?.chat.id;
  if (!parsed || chatId === undefined) {
    await answerCallbackQuery(token, callbackQuery.id).catch(() => {});
    return;
  }
  const pending = menuRegistry.take(chatId, parsed.kind, parsed.token);
  if (!pending) {
    // Expired, replaced by a newer menu of the kind, or a stale token.
    await answerCallbackQuery(token, callbackQuery.id, "Expired").catch(() => {});
    return;
  }
  if (parsed.index === MENU_CANCEL_INDEX) {
    await answerCallbackQuery(token, callbackQuery.id, "Cancelled").catch(() => {});
    await editMessageText(token, chatId, pending.messageId, "✓ Cancelled").catch(() => {});
    return;
  }
  const kind = parsed.kind;
  if (kind !== "model" && kind !== "think" && kind !== "reply" && kind !== "project" && kind !== "task") {
    await answerCallbackQuery(token, callbackQuery.id).catch(() => {});
    return;
  }
  const config = readTelegramConfig();
  const outcome = await (async (): Promise<{ applied: boolean; text: string } | null> => {
    if (kind === "reply") return applyReplyMenuSelection(chatId, parsed.index, pending.options);
    if (kind === "project") return applyProjectMenuSelection(chatId, config, parsed.index, pending.options);
    if (kind === "task") return applyTaskMenuSelection(chatId, config, parsed.index, pending.options);
    return applyModelMenuSelection(chatId, config, kind, parsed.index, pending.options);
  })().catch(
    (error): null => {
      console.warn(`[pi-web] telegram chat ${chatId}: applying a menu choice failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    },
  );
  if (outcome === null) {
    await answerCallbackQuery(token, callbackQuery.id, "Expired").catch(() => {});
    return;
  }
  if (outcome.applied) {
    await answerCallbackQuery(token, callbackQuery.id, "✓").catch(() => {});
    await editMessageText(token, chatId, pending.messageId, `✓ ${outcome.text}`).catch(() => {});
    return;
  }
  // A notice (a running turn, a failed switch) answers the toast with itself,
  // so the press still gets feedback even if the edit is rate-limited away.
  await answerCallbackQuery(token, callbackQuery.id, outcome.text).catch(() => {});
  await editMessageText(token, chatId, pending.messageId, outcome.text).catch(() => {});
}

// ---- Turn dispatch: preview lifecycle + media + approvals. ----

function dispatchTurn(token: string, chatId: number, input: TurnInput, replyMode: ReplyMode = readChatReplyMode(chatId)): void {
  // Not awaited: pi queues a prompt sent mid-run as a follow-up turn, so the
  // polling loop stays free for /stop and other chats.
  const turn = (async () => {
    const config = readTelegramConfig();
    // Tools mode counts the turn's top-level calls (nested codemode calls
    // are folded into their parent's own result) for the digest line.
    const toolCounts = replyMode === "tools" ? new Map<string, number>() : null;
    let outcome = await runChatTurn(
      chatId,
      toolCounts !== null
        ? {
            ...input,
            onToolCall: (toolName, nested) => {
              if (!nested) toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
            },
          }
        : input,
      config,
      () => sendChatAction(token, chatId),
    );
    if (!outcome.error && toolCounts !== null && toolCounts.size > 0) {
      // First-seen order; a single call collapses to the bare tool name.
      const digest = [...toolCounts].map(([name, count]) => (count === 1 ? name : `${name} ×${count}`)).join(", ");
      outcome = { ...outcome, reply: `${outcome.reply}\n\n🔧 Tools: ${digest}` };
    }
    const preview = previewOf(chatId);
    if (outcome.error) {
      const errorText = `❌ ${outcome.error}`;
      if (preview.messageId !== null && errorText.length <= TELEGRAM_MESSAGE_LIMIT) {
        await editPreview(token, chatId, errorText);
        preview.messageId = null;
      } else {
        if (preview.messageId !== null) await deleteMessage(token, chatId, preview.messageId).catch(() => {});
        preview.messageId = null;
        await reply(token, chatId, errorText);
      }
      return;
    }
    if (outcome.aborted) {
      const text = outcome.reply.trim() !== "" ? outcome.reply : "⏹ Stopped.";
      if (preview.messageId !== null && text.length <= TELEGRAM_MESSAGE_LIMIT) {
        await editPreview(token, chatId, text);
        preview.messageId = null;
      } else {
        if (preview.messageId !== null) await deleteMessage(token, chatId, preview.messageId).catch(() => {});
        preview.messageId = null;
        await reply(token, chatId, text);
      }
      return;
    }
    if (outcome.reply.trim() === "") {
      const text = "✅ The turn finished without a text reply.";
      if (preview.messageId !== null) {
        await editPreview(token, chatId, text);
        preview.messageId = null;
      } else {
        await reply(token, chatId, text);
      }
      return;
    }
    if (preview.messageId !== null) {
      // A table-carrying reply finalizes its preview as one rich message
      // (no 4096 cap applies there); otherwise the regular edit-or-resend.
      if (await finalizePreviewRich(token, chatId, preview.messageId, outcome.reply)) {
        preview.messageId = null;
        return;
      }
      if (outcome.reply.length <= TELEGRAM_MESSAGE_LIMIT) {
        await editPreview(token, chatId, outcome.reply);
        preview.messageId = null;
        return;
      }
      await deleteMessage(token, chatId, preview.messageId).catch(() => {});
    }
    preview.messageId = null;
    await reply(token, chatId, outcome.reply);
  })().finally(() => {
    if (inflightTurns.get(chatId) === turn) inflightTurns.delete(chatId);
  });
  inflightTurns.set(chatId, turn);
}

/** Photos: the largest size, downloaded and run with vision. */
async function dispatchPhoto(token: string, chatId: number, message: TelegramMessage): Promise<void> {
  const largest = message.photo?.[message.photo.length - 1];
  if (!largest) return;
  await sendChatAction(token, chatId).catch(() => {});
  let bytes: Buffer;
  let mimeType: string | null;
  try {
    ({ bytes, mimeType } = await downloadFile(token, largest.file_id));
  } catch (error) {
    await reply(token, chatId, `❌ Downloading the photo failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const images: TurnImage[] = [{
    type: "image",
    data: bytes.toString("base64"),
    mimeType: mimeType && mimeType.startsWith("image/") ? mimeType : "image/jpeg",
  }];
  dispatchTurn(token, chatId, { text: message.caption?.trim() || "Look at this image.", images });
}

/** Documents: images run with vision, small text files are inlined into the prompt, the rest are refused without a download. */
async function dispatchDocument(token: string, chatId: number, message: TelegramMessage, mode: ReplyMode = readChatReplyMode(chatId)): Promise<void> {
  const doc = message.document;
  if (!doc) return;
  const classification = classifyDocument({ fileName: doc.file_name, mimeType: doc.mime_type, fileSize: doc.file_size });
  if (classification.kind === "unsupported") {
    // Known before any download, so a refusal costs one reply and no traffic.
    await reply(token, chatId, classification.reason === "size"
      ? "❌ The file is over 1 MB — send only small text files or photos."
      : "❌ I can only read text files and images. This file type is not supported.");
    return;
  }
  await sendChatAction(token, chatId).catch(() => {});
  let bytes: Buffer;
  let mimeType: string | null;
  try {
    ({ bytes, mimeType } = await downloadFile(token, doc.file_id));
  } catch (error) {
    await reply(token, chatId, `❌ Downloading the file failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (classification.kind === "image") {
    const images: TurnImage[] = [{
      type: "image",
      data: bytes.toString("base64"),
      mimeType: mimeType && mimeType.startsWith("image/") ? mimeType : "image/jpeg",
    }];
    dispatchTurn(token, chatId, { text: message.caption?.trim() || "Look at this file.", images }, mode);
    return;
  }
  // A lossy UTF-8 read is acceptable: binary files never get this far.
  const { prompt } = buildDocumentPrompt(doc.file_name ?? "file.txt", bytes.toString("utf8"), message.caption?.trim() ?? "");
  dispatchTurn(token, chatId, { text: prompt }, mode);
}

/** Voice: transcribed through a local OpenAI-compatible endpoint when one runs. */
async function dispatchVoice(token: string, chatId: number, message: TelegramMessage): Promise<void> {
  const voice = message.voice;
  if (!voice) return;
  let bytes: Buffer;
  try {
    ({ bytes } = await downloadFile(token, voice.file_id));
  } catch (error) {
    await reply(token, chatId, `❌ Downloading the voice message failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    const form = new FormData();
    form.append("file", new Blob([bytes as unknown as BlobPart], { type: "audio/ogg" }), "voice.ogg");
    form.append("model", "whisper-1");
    const response = await fetch("http://127.0.0.1:1234/v1/audio/transcriptions", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { text?: string };
    const text = payload.text?.trim();
    if (!text) throw new Error("empty transcript");
    dispatchTurn(token, chatId, { text: `${text}\n(a voice message, transcribed)` });
  } catch (error) {
    await reply(token, chatId, `🎤 Voice transcription is unavailable (${error instanceof Error ? error.message : String(error)}). Please type, or send a photo.`);
  }
}

async function handleUpdate(token: string, update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallbackQuery(token, update.callback_query);
    return;
  }
  const message = update.message ?? update.edited_message;
  if (!message) return;
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
  let text = (message.text ?? "").trim();
  const botUsername = runtime().info.botUsername;
  // Groups: only messages that mention the bot or reply to it are answered.
  if (message.chat.type === "group" || message.chat.type === "supergroup") {
    const mentioned = botUsername !== null && text.includes(`@${botUsername}`);
    const replyToBot = message.reply_to_message?.from?.username !== undefined
      && message.reply_to_message.from.username === botUsername;
    const commandsAnswered = text.startsWith("/") && (mentioned || replyToBot);
    if (!mentioned && !replyToBot && !commandsAnswered) return;
    if (botUsername !== null) text = text.split(`@${botUsername}`).join("").trim();
  }
  if (message.voice) {
    await dispatchVoice(token, chatId, message);
    return;
  }
  if (message.photo?.length) {
    await dispatchPhoto(token, chatId, message);
    return;
  }
  if (message.document) {
    await dispatchDocument(token, chatId, message);
    return;
  }
  if (text === "") return;

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
  if (text === "/name" || text.startsWith("/name ")) {
    const name = text.slice(5).trim();
    if (name === "") {
      const binding = readTelegramState().chats[String(chatId)];
      const wrapper = binding ? getRpcSession(binding.sessionId) : undefined;
      const state = wrapper && wrapper.isAlive() ? await wrapper.send({ type: "get_state" }) as { sessionName?: string | null } : null;
      await reply(token, chatId, state?.sessionName ? `📌 Current name: ${state.sessionName}` : "📌 No name yet. Use /name <title>.");
      return;
    }
    const result = await withChatWrapper(chatId, config, async (wrapper) => {
      await wrapper.send({ type: "set_session_name", name });
      return { outcome: "named" as const };
    });
    await reply(token, chatId, "error" in result ? `❌ ${result.error}` : `✏️ Session named “${name}”.`);
    return;
  }
  if (text === "/compact") {
    const result = await withChatWrapper(chatId, config, async (wrapper) => {
      await reply(token, chatId, "🧹 Compacting…");
      await wrapper.send({ type: "compact" });
      return { outcome: "compacted" as const };
    });
    await reply(token, chatId, "error" in result ? `❌ ${result.error}` : "✅ Session compacted.");
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
  if (text === "/model" || text.startsWith("/model ")) {
    await handleModelCommand(token, chatId, config, text.slice("/model".length).trim(), menuRegistry);
    return;
  }
  if (text === "/think") {
    await handleThinkCommand(token, chatId, config, menuRegistry);
    return;
  }
  if (text === "/reply") {
    await handleReplyCommand(token, chatId, config, menuRegistry);
    return;
  }
  if (text === "/project") {
    await handleProjectCommand(token, chatId, config, menuRegistry);
    return;
  }
  if (text === "/task") {
    await handleTaskCommand(token, chatId, config, menuRegistry);
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
  // The reply mode is read once at dispatch: final-only turns send no
  // preview message and stream nothing — the completed reply arrives as one
  // message (the same path photo and voice turns already take).
  const replyMode = readChatReplyMode(chatId);
  if (replyMode !== "final") void ensurePreviewMessage(token, chatId, "…");
  dispatchTurn(
    token,
    chatId,
    {
      text,
      ...(replyMode !== "final"
        ? {
            onProgress: (partial: string) => {
              const preview = previewOf(chatId);
              const shown = partial.length > TELEGRAM_MESSAGE_LIMIT - 10
                ? `${partial.slice(0, TELEGRAM_MESSAGE_LIMIT - 12)}…\n▍`
                : `${partial}\n▍`;
              if (preview.messageId === null || previewWantsEdit(preview, shown)) {
                void editPreview(token, chatId, shown);
              }
            },
          }
        : {}),
      onUiRequest: (request) => {
        void offerUiRequest(token, chatId, request);
      },
    },
    replyMode,
  );
}
