# Channels (Telegram)

The Telegram channel's outgoing-message pipeline and its traps.

Files: `lib/telegram/bot-api.ts`, `lib/telegram/message-text.ts`, `lib/telegram/rich-send.ts`, `lib/telegram/runtime.ts`, `lib/telegram/session-bridge.ts`, `lib/telegram/menus.ts`, `lib/telegram/command-model.ts`, `lib/telegram/command-reply.ts`, `lib/telegram/command-project.ts`, `lib/telegram/command-task.ts`, `lib/telegram/attachments.ts`, `lib/telegram/prefs.ts`, `lib/telegram/model-listing.ts`, `lib/automations/notify.ts`.

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

## Inline menus (/model, /think, /reply, /project)

`lib/telegram/menus.ts` is the reusable scaffolding (every menu command, `/task` included, reuses it): callback data is `m:<kind>:<token>:<index>` (`-1` = the Cancel row), and one `TelegramMenuRegistry` — module scope in `runtime.ts`, like `pendingUi` — holds the pending menu per chat+kind. A fresh issue of the same kind replaces the old token (a stale button press answers "Expired"), entries live 10 minutes, and the map is capped at 100. The token must exist before the keyboard is built but the registry entry wants the sent message's id, so callers mint it with `newMenuToken()` and pass it into `issue()`.

`command-model.ts` applies a press through `withChatWrapper` with an `isRunning()` guard — a mid-turn press answers "⏳ A turn is running…" and applies nothing. The stored option id is applied as issued (`provider/modelId` for models, split on the first `/`; the level string for think): the session may have been `/new`-ed since issuing (still the same cwd), and a model that vanished makes `set_model` fail into a notice. `model-listing.ts` mirrors `/api/models`' loader and shares its cwd-keyed cache — it keeps the route's full data shape on purpose so whichever caller fills the cache first, the other finds every field it expects.

`/reply`'s modes are per-chat runtime state in the channels STATE file (`prefs.ts`), read once at turn dispatch — a switch lands from the NEXT turn, and `final` is only the preview message + `onProgress` skipped (the path photo/voice turns already take; the outcome branches already tolerate a null preview). `/project` writes the chat's `allowedChats[].cwd` override in the CONFIG and resets the session, so the folder is real for the NEXT session; its busy guard reads the live wrapper (`getRpcSession(binding.sessionId)`, like `/stop`) because the binding may have changed since the menu was issued. `/task` rebinds the chat to an earlier session in the same folder — the rebind plus its reopen verification run inside the per-chat gate (`withChatGate`, where every turn's bind phase runs), or a message arriving mid-switch could interleave its own bind; attachments are classified (`attachments.ts`) before any download, so a refusal costs no traffic.
