import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SharePanelView, shareLinkUrl, shareCreateFailure } = await jiti.import("./SharePanel.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
// As SharePanel.tsx imports it: the same specifier, so one context instance.
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

// SharePanelView is client React but has no browser dependency; render it with
// the provider's default English (the locale effect never runs server-side).
const renderView = (props) => renderToStaticMarkup(
  React.createElement(I18nProvider, null, React.createElement(SharePanelView, props)),
);

const baseProps = {
  messageCount: null,
  busy: null,
  error: null,
  stopArmed: false,
  origin: "https://pi.example.com",
  onCopy: () => {},
  onCreate: () => {},
  onRefresh: () => {},
  onStop: () => {},
};

const share = { code: "abc123_-XYZ4567890123456", createdAt: "2026-10-25T00:00:00.000Z", title: "T" };

test("shareLinkUrl joins the origin and the code path", () => {
  assert.equal(shareLinkUrl("https://pi.example.com", "abc123_-XYZ4567890123456"), "https://pi.example.com/share/abc123_-XYZ4567890123456");
});

test("shareCreateFailure maps the size limit and passes other errors through", () => {
  assert.deepEqual(shareCreateFailure({ error: "The session snapshot is 31 MB; the limit is 25 MB", code: "too_large" }, 413), { key: "share.tooLarge" });
  assert.deepEqual(shareCreateFailure({ error: "boom" }, 500), { key: "share.createError", params: { error: "boom" } });
  assert.deepEqual(shareCreateFailure({}, 502), { key: "share.createError", params: { error: "HTTP 502" } });
});

test("an unshared session shows the disclosure and the create button", () => {
  const html = renderView({ ...baseProps, state: { status: "unshared" }, messageCount: 12 });
  assert.ok(html.includes("Share this session"));
  assert.ok(html.includes("12 messages"));
  assert.ok(html.includes("Create share link"));
});

test("a shared session shows the link, copy, refresh and the unarmed stop", () => {
  const html = renderView({ ...baseProps, state: { status: "shared", share } });
  assert.ok(html.includes("https://pi.example.com/share/abc123_-XYZ4567890123456"));
  assert.ok(html.includes("Copy"));
  assert.ok(html.includes("Refresh content"));
  assert.ok(html.includes("Stop sharing"));
  assert.ok(!html.includes("Confirm: stop sharing"));
});

test("an armed stop and a failure render their own words", () => {
  const html = renderView({ ...baseProps, state: { status: "shared", share }, stopArmed: true, error: "Couldn’t stop sharing: boom" });
  assert.ok(html.includes("Confirm: stop sharing"));
  assert.ok(html.includes("Couldn’t stop sharing: boom"));
});

test("a failed load and the loading state render", () => {
  const failed = renderView({ ...baseProps, state: { status: "load-failed", error: "HTTP 500" } });
  assert.ok(failed.includes("HTTP 500"));
  const loading = renderView({ ...baseProps, state: { status: "loading" } });
  assert.ok(loading.includes("Loading..."));
});
