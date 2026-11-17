import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SharesConfigView } = await jiti.import("./SharesConfig.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
// As SharesConfig.tsx imports it: the same specifier, so one context instance.
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

// SharesConfigView is client React but has no browser dependency; render it
// with the provider's default English (the locale effect never runs
// server-side). The container's fetches and confirm machines stay untested
// here, as with ChannelsConfig — only the pure render is covered.
const renderView = (props) => renderToStaticMarkup(
  React.createElement(I18nProvider, null, React.createElement(SharesConfigView, props)),
);

const noop = () => {};
const day = 86_400_000;
const isoFromNow = (days) => new Date(Date.now() + days * day).toISOString();

const baseProps = {
  embedded: true,
  onClose: noop,
  loadError: null,
  selected: new Set(),
  busy: null,
  line: null,
  revokeArmedRow: null,
  revokeAllArmed: false,
  renewDrafts: {},
  onToggleRow: noop,
  onToggleAll: noop,
  onRenewDraft: noop,
  onRenew: noop,
  onRevoke: noop,
  onRevokeSelected: noop,
  onReload: noop,
  onCopyLink: noop,
};

const item = (overrides = {}) => ({
  sessionId: "019a0000000000000000000000",
  code: "abcdefghij0123456789_-",
  title: "Fix login",
  createdAt: isoFromNow(-1),
  expiresAt: isoFromNow(7),
  durationDays: 7,
  expired: false,
  orphan: false,
  ...overrides,
});

test("an empty list shows the empty state and no table", () => {
  const html = renderView({ ...baseProps, items: [] });
  assert.ok(html.includes("No shared sessions"));
  assert.ok(!html.includes("<table"));
});

test("a load failure says so", () => {
  const html = renderView({ ...baseProps, items: null, loadError: "HTTP 500" });
  assert.ok(html.includes("Couldn’t load shares: HTTP 500"));
  assert.ok(!html.includes("<table"));
});

test("a live row shows its title link, code tail and remaining validity", () => {
  const html = renderView({ ...baseProps, items: [item()] });
  assert.ok(html.includes('href="/share/abcdefghij0123456789_-"'));
  assert.ok(html.includes("Fix login"));
  assert.ok(html.includes(`…${"abcdefghij0123456789_-".slice(-6)}`));
  assert.ok(html.includes("Expires in 7 days"));
  assert.ok(html.includes("1 share"));
  // The page's own description mentions "Expired links" — assert the badge's
  // exact markup instead, mirroring the expired-row test below.
  assert.ok(!html.includes('is-warning">Expired<'));
});

test("an expired row wears the Expired badge and past tense", () => {
  const html = renderView({ ...baseProps, items: [item({ expired: true, expiresAt: isoFromNow(-2) })] });
  assert.ok(html.includes('is-warning">Expired<'));
  assert.ok(html.includes("Expired 2 days ago"));
});

test("an orphan row wears the Session deleted badge", () => {
  const html = renderView({ ...baseProps, items: [item({ orphan: true })] });
  assert.ok(html.includes("Session deleted"));
  // The hint explains the badge once, as its tooltip.
  assert.ok(html.includes("The session behind this link no longer exists"));
});

test("a permanent row says so", () => {
  const html = renderView({ ...baseProps, items: [item({ expiresAt: null })] });
  assert.ok(html.includes("Permanent"));
});

test("the header offers select-all and each row its checkbox", () => {
  const html = renderView({ ...baseProps, items: [item(), item({ sessionId: "019b0000000000000000000000" })] });
  assert.ok(html.includes('aria-label="Select all"'));
  // Each row's checkbox carries its own title so screen readers can tell them apart.
  assert.equal((html.match(/aria-label="Select: /g) || []).length, 2);
});

test("a selection shows the count; none disables the batch revoke", () => {
  const none = renderView({ ...baseProps, items: [item()] });
  assert.ok(none.includes("Revoke selected (0)"));
  assert.match(none, /<button[^>]*disabled[^>]*>[^<]*Revoke selected \(0\)</);
  const one = renderView({ ...baseProps, items: [item()], selected: new Set(["019a0000000000000000000000"]) });
  assert.ok(one.includes("Revoke selected (1)"));
});

test("the armed batch revoke shows its confirmation", () => {
  const html = renderView({
    ...baseProps,
    items: [item()],
    selected: new Set(["019a0000000000000000000000"]),
    revokeAllArmed: true,
  });
  assert.ok(html.includes("Confirm: revoke 1 links"));
  assert.ok(!html.includes("Revoke selected (1)"));
});

test("an armed row revoke shows its confirmation", () => {
  const html = renderView({ ...baseProps, items: [item()], revokeArmedRow: "019a0000000000000000000000" });
  assert.ok(html.includes(">Confirm: revoke</button>"));
});

test("each row's renew select offers the four tiers on the stored one", () => {
  const html = renderView({
    ...baseProps,
    items: [item({ createdAt: isoFromNow(-30), expiresAt: isoFromNow(0) })],
    renewDrafts: { "019a0000000000000000000000": 30 },
  });
  assert.equal((html.match(/<option/g) || []).length, 4);
  assert.match(html, /<option[^>]*selected[^>]*>30 days<\/option>/);
  assert.ok(html.includes(">Forever</option>"));
  assert.ok(html.includes("Copy link"));
  assert.ok(html.includes(">Renew</button>"));
  assert.ok(html.includes(">Revoke</button>"));
});
