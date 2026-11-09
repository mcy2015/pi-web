// Sending Markdown text to a Telegram chat, three layers deep:
// 1. a rich message (Bot API 10.1 sendRichMessage) whenever the text holds a
//    Markdown pipe table — rich Markdown renders tables natively, and sending
//    the whole reply as one message keeps a table from being split apart;
// 2. sendMessage with Telegram HTML, where markdownToTelegramHtml has already
//    reshaped tables into vertical lists;
// 3. plain text when Telegram rejects the HTML.
// A rich attempt that fails as a TelegramApiError (an old Bot API endpoint or
// a dialect parse error) silently falls through to the next layer, so a rich
// failure can never lose a message.

import {
  sendMessage,
  sendRichMessage,
  editMessageText,
  TelegramApiError,
} from "./bot-api";
import {
  hasMarkdownTable,
  protectUnderscoresForRichMarkdown,
  markdownToTelegramHtml,
  splitForTelegram,
} from "./message-text";

/** Rich messages carry up to 32768 characters; keep a margin below that. */
export const TELEGRAM_RICH_MESSAGE_LIMIT = 32_000;

/** One chunk: rich when it holds a table, else Telegram HTML with a plain
 * fallback. Resolves with the sent message's id. */
async function sendMarkdownChunk(token: string, chatId: number, markdown: string): Promise<number> {
  if (hasMarkdownTable(markdown)) {
    try {
      return (await sendRichMessage(token, chatId, protectUnderscoresForRichMarkdown(markdown))).message_id;
    } catch (error) {
      if (!(error instanceof TelegramApiError)) throw error;
    }
  }
  try {
    return (await sendMessage(token, chatId, markdownToTelegramHtml(markdown), { parseMode: "HTML" })).message_id;
  } catch (error) {
    if (error instanceof TelegramApiError && error.statusCode === 400) {
      return (await sendMessage(token, chatId, markdown)).message_id;
    }
    throw error;
  }
}

/**
 * Sends a Markdown reply to a chat. A table-carrying reply that fits one rich
 * message goes out whole (a real rendered table); everything else arrives as
 * Telegram-HTML chunks. Resolves with the ids of every message sent (the
 * automations announce records them so a Telegram reply to the announce can
 * be matched back to its briefing); empty text sends nothing. Throws only
 * when every layer for a chunk failed.
 */
export async function sendMarkdownText(token: string, chatId: number, text: string): Promise<number[]> {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (hasMarkdownTable(trimmed) && trimmed.length <= TELEGRAM_RICH_MESSAGE_LIMIT) {
    try {
      return [(await sendRichMessage(token, chatId, protectUnderscoresForRichMarkdown(trimmed))).message_id];
    } catch (error) {
      if (!(error instanceof TelegramApiError)) throw error;
    }
  }
  const messageIds: number[] = [];
  for (const chunk of splitForTelegram(trimmed)) {
    messageIds.push(await sendMarkdownChunk(token, chatId, chunk));
  }
  return messageIds;
}

/**
 * Finalizes a streaming preview message as a rich message when its final text
 * holds a table. Returns true when the edit went through; false means the
 * caller should fall back to its regular edit-or-resend path.
 */
export async function finalizePreviewRich(
  token: string,
  chatId: number,
  messageId: number,
  markdown: string,
): Promise<boolean> {
  if (!hasMarkdownTable(markdown) || markdown.trim().length > TELEGRAM_RICH_MESSAGE_LIMIT) return false;
  try {
    await editMessageText(token, chatId, messageId, "", {
      richMarkdown: protectUnderscoresForRichMarkdown(markdown.trim()),
    });
    return true;
  } catch (error) {
    if (!(error instanceof TelegramApiError)) throw error;
    return false;
  }
}
