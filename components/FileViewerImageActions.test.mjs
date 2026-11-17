import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { AddToChatButton, CopyImageButton } = await jiti.import("./FileViewerImageActions.tsx");

// I18nProvider renders its default locale (en) until its effect runs, which
// renderToStaticMarkup never does.
function render(element) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, element));
}

test("AddToChatButton without a handler renders nothing", () => {
  assert.equal(render(React.createElement(AddToChatButton, { filePath: "/tmp/a.png", onAddToChat: null })), "");
});

test("AddToChatButton with a handler is a labelled icon button", () => {
  const html = render(React.createElement(AddToChatButton, { filePath: "/tmp/a.png", onAddToChat: () => {} }));
  assert.match(html, /^<button type="button" class="file-viewer-icon-button"/);
  assert.match(html, /title="Add image to chat"/);
  assert.match(html, /aria-label="Add image to chat"/);
});

test("CopyImageButton says what it does, and warns about an animated GIF", () => {
  const plain = render(React.createElement(CopyImageButton, { url: "/api/files/a.png?type=read", isAnimatedGif: false }));
  assert.match(plain, /title="Copy image"/);
  assert.match(plain, /aria-label="Copy image"/);
  assert.ok(!plain.includes("animated GIF"));

  const gif = render(React.createElement(CopyImageButton, { url: "/api/files/a.gif?type=read", isAnimatedGif: true }));
  assert.match(gif, /title="Copy image \(an animated GIF copies as a single frame\)"/);
  assert.match(gif, /aria-label="Copy image \(an animated GIF copies as a single frame\)"/);
});
