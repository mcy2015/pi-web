import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SharePanelView, shareLinkUrl, shareCreateFailure, shareCreateBody } = await jiti.import("./SharePanel.tsx");
const { inferShareDurationDays } = await jiti.import("@/lib/share-types");
const { formatRelativeTime, translateMessage } = await jiti.import("@/lib/i18n/format");
const { getLocalePlugin, getSupportedLocales } = await jiti.import("@/lib/i18n/registry");
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
  duration: 7,
  origin: "https://pi.example.com",
  onCopy: () => {},
  onCreate: () => {},
  onRefresh: () => {},
  onStop: () => {},
  onDurationChange: () => {},
};

const day = 86_400_000;
const isoFromNow = (days) => new Date(Date.now() + days * day).toISOString();

const share = { code: "abc123_-XYZ4567890123456", createdAt: isoFromNow(-1), expiresAt: isoFromNow(7), durationDays: 7, title: "T" };

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

test("shareCreateBody carries the chosen duration", () => {
  assert.deepEqual(JSON.parse(shareCreateBody(7)), { durationDays: 7 });
  assert.deepEqual(JSON.parse(shareCreateBody(null)), { durationDays: null });
  assert.deepEqual(JSON.parse(shareCreateBody(1)), { durationDays: 1 });
});

test("inferShareDurationDays reads the stored tier and only infers exact differences", () => {
  // Stored value wins, even when renew moved expiresAt off any choice.
  assert.equal(inferShareDurationDays({ durationDays: 30, expiresAt: isoFromNow(-2), createdAt: isoFromNow(-32) }), 30);
  assert.equal(inferShareDurationDays({ durationDays: null, expiresAt: isoFromNow(-2), createdAt: isoFromNow(-32) }), null);
  // Old files without durationDays: exact differences only.
  assert.equal(inferShareDurationDays({ expiresAt: isoFromNow(6), createdAt: isoFromNow(-1) }), 7);
  assert.equal(inferShareDurationDays({ expiresAt: isoFromNow(0), createdAt: isoFromNow(-1) }), 1);
  assert.equal(inferShareDurationDays({ expiresAt: isoFromNow(29), createdAt: isoFromNow(-1) }), 30);
  assert.equal(inferShareDurationDays({ expiresAt: isoFromNow(31), createdAt: isoFromNow(-1) }), 7);
  assert.equal(inferShareDurationDays({ expiresAt: null, createdAt: isoFromNow(-1) }), null);
  assert.equal(inferShareDurationDays({ createdAt: isoFromNow(-1) }), null);
});

test("an unshared session offers the four durations with 7 days picked", () => {
  const html = renderView({ ...baseProps, state: { status: "unshared" } });
  assert.ok(html.includes("Link validity"));
  assert.equal((html.match(/<option/g) || []).length, 4);
  assert.match(html, /<option[^>]*selected[^>]*>7 days<\/option>/);
  assert.ok(html.includes(">Forever</option>"));
});

test("a shared session shows the remaining time under the link", () => {
  const html = renderView({ ...baseProps, state: { status: "shared", share } });
  assert.ok(html.includes("Expires in 7 days"));
});

test("an expired shared session says so and points at refresh", () => {
  const expired = { ...share, expiresAt: isoFromNow(-2) };
  const html = renderView({ ...baseProps, state: { status: "shared", share: expired } });
  assert.ok(html.includes(">Expired</p>"));
  assert.ok(html.includes("This link no longer opens. Refresh content to issue it again."));
  assert.ok(!html.includes("Expires in"));
});

test("a permanent shared session says so", () => {
  const html = renderView({ ...baseProps, state: { status: "shared", share: { ...share, expiresAt: null } } });
  assert.ok(html.includes(">Permanent</p>"));
  assert.ok(!html.includes("Expires in"));
});

test("zh validity lines never double the relative time's own 后/後 (MAJOR-1)", () => {
  const messages = Object.fromEntries(getSupportedLocales().map((id) => [id, getLocalePlugin(id).messages]));
  const future = new Date(Date.now() + 3 * day);
  for (const locale of ["zh-CN", "zh-TW"]) {
    const time = formatRelativeTime(future, locale);
    for (const key of ["share.expiresIn", "shares.expiresIn", "shares.renewed"]) {
      const text = translateMessage(locale, key, messages, { time });
      assert.ok(!text.includes("后后") && !text.includes("後後"), `${locale} ${key} doubled the suffix: ${text}`);
      assert.ok(text.includes("过期") || text.includes("過期"), `${locale} ${key} lost its expiry word: ${text}`);
    }
  }
});
