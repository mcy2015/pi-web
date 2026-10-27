import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { agentMessageText, splitForTelegram, firstChatTitle, markdownToTelegramHtml, hasMarkdownTable, protectUnderscoresForRichMarkdown, TELEGRAM_MESSAGE_LIMIT } = await jiti.import("./message-text.ts");

test("agentMessageText: strings pass through, block arrays join text blocks", () => {
  assert.equal(agentMessageText({ role: "assistant", content: "hello" }), "hello");
  assert.equal(
    agentMessageText({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "first" },
        { type: "text", text: "second" },
        { type: "tool_use", id: "t1", name: "bash", input: {} },
      ],
    }),
    "first\n\nsecond",
  );
  assert.equal(agentMessageText({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] }), "");
  assert.equal(agentMessageText({ role: "assistant", content: null }), "");
});

test("splitForTelegram: short text stays whole, long text breaks on boundaries", () => {
  assert.deepEqual(splitForTelegram(""), []);
  assert.deepEqual(splitForTelegram("  hi  "), ["hi"]);

  const paragraphs = ["a".repeat(1000), "b".repeat(1000), "c".repeat(1000), "d".repeat(1000), "e".repeat(1000)];
  const text = paragraphs.join("\n\n");
  assert.ok(text.length > TELEGRAM_MESSAGE_LIMIT);
  const chunks = splitForTelegram(text);
  for (const chunk of chunks) assert.ok(chunk.length <= TELEGRAM_MESSAGE_LIMIT, `chunk too long: ${chunk.length}`);
  // The cut lands on a paragraph boundary, so every paragraph arrives whole
  // and nothing but the separators is dropped.
  const joined = chunks.join("\n\n");
  for (const paragraph of paragraphs) assert.ok(joined.includes(paragraph));
  assert.equal(joined.replace(/\s/g, ""), text.replace(/\s/g, ""));

  // A single unbreakable monster line is hard-split at the limit.
  const monster = "x".repeat(TELEGRAM_MESSAGE_LIMIT + 50);
  const hard = splitForTelegram(monster);
  assert.deepEqual(hard, ["x".repeat(TELEGRAM_MESSAGE_LIMIT), "x".repeat(50)]);

  // Word boundaries beat character positions when they fit.
  const words = Array.from({ length: 1200 }, (_, i) => `w${i}`).join(" ");
  const wordChunks = splitForTelegram(words);
  for (const chunk of wordChunks) assert.ok(chunk.length <= TELEGRAM_MESSAGE_LIMIT);
  assert.equal(wordChunks.join(" "), words);
});

test("markdownToTelegramHtml: paired markers become tags, everything else survives", () => {
  assert.equal(markdownToTelegramHtml("**bold** and *italic*"), "<b>bold</b> and <i>italic</i>");
  assert.equal(markdownToTelegramHtml("a `code` here"), "a <code>code</code> here");
  assert.equal(markdownToTelegramHtml("# Heading\nbody"), "<b>Heading</b>\nbody");
  assert.equal(
    markdownToTelegramHtml("see [pi](https://example.com/a?b=1) now"),
    'see <a href="https://example.com/a?b=1">pi</a> now',
  );
  assert.equal(
    markdownToTelegramHtml("```ts\nconst a = 1 < 2;\n```"),
    "<pre>const a = 1 &lt; 2;</pre>",
  );

  // Text characters that HTML would read as markup are escaped.
  assert.equal(markdownToTelegramHtml("1 < 2 && 3 > 2"), "1 &lt; 2 &amp;&amp; 3 &gt; 2");

  // Unpaired markers and snake_case stay plain, never mangling the text.
  assert.equal(markdownToTelegramHtml("a lone ** and a lone *"), "a lone ** and a lone *");
  assert.equal(markdownToTelegramHtml("snake_case_name"), "snake_case_name");

  // Fenced content is untouched by the inline passes (markers stay literal).
  assert.equal(
    markdownToTelegramHtml("before\n```\n**not bold**\n```\nafter"),
    "before\n<pre>**not bold**</pre>\nafter",
  );

  // Markdown bullets become real • characters, nesting indent kept; a minus
  // glued to text or a horizontal rule is not a bullet and stays as-is.
  assert.equal(markdownToTelegramHtml("- one\n- two\n  - nested"), "• one\n• two\n  • nested");
  assert.equal(markdownToTelegramHtml("* star bullet"), "• star bullet");
  assert.equal(markdownToTelegramHtml("-5 degrees and ---"), "-5 degrees and ---");
});

test("firstChatTitle falls back to the chat id", () => {
  assert.equal(firstChatTitle("Henry", 1), "Henry");
  assert.equal(firstChatTitle("  ", 99), "chat 99");
  assert.equal(firstChatTitle(null, -1001234), "chat -1001234");
});

// ---- Tables and rich-message preparation ----

test("hasMarkdownTable: a pipe table with a divider row, nothing else", () => {
  assert.equal(hasMarkdownTable("| a | b |\n|---|---|\n| 1 | 2 |"), true);
  assert.equal(hasMarkdownTable("| a | b |\n| no divider | here |\n| 1 | 2 |"), false);
  assert.equal(hasMarkdownTable("plain text\n---\nno table header above"), false);
  // A table inside a fenced block is code, not a table.
  assert.equal(hasMarkdownTable("```\n| a | b |\n|---|---|\n```"), false);
  // Alignment colons are still divider rows.
  assert.equal(hasMarkdownTable("| x | y |\n| :--- | ---: |\n| 1 | 2 |"), true);
});

test("markdownToTelegramHtml: a table becomes a vertical list", () => {
  const html = markdownToTelegramHtml(
    [
      "## 对比",
      "",
      "| 维度 | S23 | S26 |",
      "|---|---|---|",
      "| 芯片 | 8 Gen 2 | 8 Elite |",
      "| 电池 | 3900 | 4300 |",
      "",
      "after",
    ].join("\n"),
  );
  // No pipes survive; each row is a bold lead plus labeled lines.
  assert.ok(!html.includes("|"), html);
  assert.ok(html.includes("<b>对比</b>"));
  assert.ok(html.includes("<b>芯片</b>"));
  assert.ok(html.includes("S23: 8 Gen 2"));
  assert.ok(html.includes("S26: 8 Elite"));
  assert.ok(html.includes("<b>电池</b>"));
  assert.ok(html.includes("after"));
  // A table in a fenced block stays code.
  const fenced = markdownToTelegramHtml("```\n| a | b |\n|---|---|\n| 1 | 2 |\n```");
  assert.ok(fenced.includes("<pre>"), fenced);
  assert.ok(fenced.includes("| a | b |"), fenced);
});

test("markdownToTelegramHtml: empty header cells and escaped pipes", () => {
  // The follow-up table shape: an empty first header, an unlabeled column.
  const html = markdownToTelegramHtml(
    ["| | S23 | S26 |", "|---|---|---|", "| 长宽比 | 19.5:9 | 19.5:9 |"].join("\n"),
  );
  assert.ok(!html.includes("|"), html);
  assert.ok(html.includes("<b>长宽比</b>"), html);
  assert.ok(html.includes("S23: 19.5:9"), html);
  // An escaped pipe inside a cell is cell content, not a splitter.
  const escaped = markdownToTelegramHtml(
    ["| cmd | note |", "|---|---|", "| a \\| b | pipe kept |"].join("\n"),
  );
  assert.ok(escaped.includes("a | b"), escaped);
});

test("protectUnderscoresForRichMarkdown: inner underscores become code spans", () => {
  assert.equal(
    protectUnderscoresForRichMarkdown("uses split_for_telegram here"),
    "uses `split_for_telegram` here",
  );
  // A word glued to full-width punctuation still gets protected.
  assert.equal(
    protectUnderscoresForRichMarkdown("函数（split_for_telegram）保护"),
    "函数（`split_for_telegram`）保护",
  );
  // Emphasis syntax keeps its underscores.
  assert.equal(protectUnderscoresForRichMarkdown("__bold__ and _italic_"), "__bold__ and _italic_");
  assert.equal(protectUnderscoresForRichMarkdown("plain snake"), "plain snake");
  // Code spans, fenced blocks and links are untouched.
  assert.equal(protectUnderscoresForRichMarkdown("a `snake_case` b"), "a `snake_case` b");
  assert.equal(
    protectUnderscoresForRichMarkdown("```\nsnake_case\n```"),
    "```\nsnake_case\n```",
  );
  assert.equal(
    protectUnderscoresForRichMarkdown("see [a_b](https://x.com/c_d) now"),
    "see [a_b](https://x.com/c_d) now",
  );
  // Paths and dates with underscores are protected too.
  assert.equal(
    protectUnderscoresForRichMarkdown("in ~/pi-cwd/2026_10_27 now"),
    "in `~/pi-cwd/2026_10_27` now",
  );
});
