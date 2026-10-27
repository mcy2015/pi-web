# Channels (Telegram)

The Telegram channel's outgoing-message pipeline and its traps.

Files: `lib/telegram/bot-api.ts`, `lib/telegram/message-text.ts`, `lib/telegram/rich-send.ts`, `lib/telegram/runtime.ts`, `lib/telegram/session-bridge.ts`, `lib/automations/notify.ts`.

## Sending Markdown replies: three layers

`lib/telegram/rich-send.ts` owns every outgoing reply (chat replies, the automations announce, the streaming preview's final edit):

1. **Rich message** — Bot API 10.1 (2026-06-11) `sendRichMessage` with `rich_message: { markdown }`. Rich Markdown renders GFM pipe tables natively (sendMessage's parse modes have no table entity at all), plus headings, task lists and footnotes. Used whenever the text holds a table (`hasMarkdownTable()`: a `|`-starting row followed by a divider row, fenced code excluded) and it fits one message (`TELEGRAM_RICH_MESSAGE_LIMIT`, 32 000 under the API's 32 768): the whole reply then goes out as one message so no 4096 split can cut the table apart.
2. **sendMessage + Telegram HTML** — `markdownToTelegramHtml()`; tables already reshaped into vertical lists (`tablesToVerticalLists()`: first column bold, the rest `header: value` lines) since HTML parse mode cannot express a table.
3. **Plain text** — when Telegram rejects the HTML (400).

A rich attempt failing as `TelegramApiError` (old endpoint, dialect parse error) falls through to the next layer, never losing the message. The streaming preview edits plain/HTML mid-stream and, on the turn's final text, tries `editMessageText` with `rich_message` first (`finalizePreviewRich()`); editing a text-mode message into a rich one works (verified live, 2026-10-27).

## Traps

- **Rich Markdown reads `_text_` as italic.** A bare `snake_case` token loses its underscores; `protectUnderscoresForRichMarkdown()` turns such words into code spans (path characters included, so `~/pi-cwd/2026_10_27` is covered) while code spans, fenced blocks, links and `_italic_`/`__bold__` markers keep theirs. Words glued to full-width punctuation are still caught (the pass works per word inside each whitespace token, not per token).
- `splitForTelegram()` still chunks at 4096; only the rich layer may exceed it (a table-carrying reply up to 32 000 goes as one rich message).
- `hasMarkdownTable()` must strip fenced blocks first: a table sample quoted in a code block is code, not a table.
