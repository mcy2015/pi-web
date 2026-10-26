import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { agentMessageText, splitForTelegram, firstChatTitle, markdownToTelegramHtml, TELEGRAM_MESSAGE_LIMIT } = await jiti.import("./message-text.ts");

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
