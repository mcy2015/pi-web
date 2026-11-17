import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Static rendering: renderToStaticMarkup runs no effects, so within these
// tests the whole composer stays in its pre-hydration state — supported is
// false and the mic button hidden. The button and status line are therefore
// driven through their props; the hook's own supported migration is covered by
// hooks/useSpeechInput.test.mjs.
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput, SpeechMicButton, SpeechStatusLine } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en");
const { zhCNLocale } = await jiti.import("@/lib/i18n/messages/zh-CN");
const { zhTWLocale } = await jiti.import("@/lib/i18n/messages/zh-TW");

const t = (key) => enLocale.messages[key] ?? key;
const mic = (props) => renderToStaticMarkup(React.createElement(SpeechMicButton, {
  title: "Voice input",
  ariaLabel: "Voice input",
  onClick() {},
  ...props,
}));
const line = (props) => renderToStaticMarkup(React.createElement(SpeechStatusLine, { t, onRetry() {}, ...props }));

test("the dictation toggle shows its state, size and platform", () => {
  const idle = mic({ listening: false, isMobile: false });
  assert.match(idle, /aria-pressed="false"/);
  assert.match(idle, /width:34px/);
  assert.match(idle, /height:34px/);
  assert.match(idle, /color:var\(--text-muted\)/);
  assert.match(idle, /fill="none"/, "an idle mic is an outline");

  const listening = mic({ listening: true, isMobile: false });
  assert.match(listening, /aria-pressed="true"/);
  assert.match(listening, /color:var\(--accent\)/);
  assert.match(listening, /fill="currentColor"/, "a listening mic is solid and accented");

  const phone = mic({ listening: false, isMobile: true });
  assert.match(phone, /width:36px/);
  assert.match(phone, /height:36px/);
});

test("the status line carries the live interim while listening and nothing while idle", () => {
  const listening = line({ status: "listening", errorKind: null, interim: "hello wor" });
  assert.match(listening, /Listening…/);
  assert.match(listening, /hello wor/);

  assert.equal(line({ status: "idle", errorKind: null, interim: "" }), "");
});

test("the status line explains each error and offers the retry", () => {
  const permission = line({ status: "error", errorKind: "permission", interim: "" });
  assert.match(permission, /Microphone access was denied\./);
  assert.match(permission, /site settings/);
  assert.match(permission, />Retry</);
  assert.match(permission, /rgba\(239,68,68\)/, "ModelNoticeBanner's literal red, no --danger token");

  assert.match(line({ status: "error", errorKind: "mic", interim: "" }), /No microphone found\./);
  assert.match(line({ status: "error", errorKind: "network", interim: "" }), /Speech service unreachable\./);
  assert.match(line({ status: "error", errorKind: "unavailable", interim: "" }), /stopped unexpectedly\./);
});

test("without a SpeechRecognition engine the composer renders no mic button", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
    })),
  );
  // The gate's false branch. The true branch — the button appearing once the
  // hydration effect finds the constructor — is weakly covered here by design;
  // hooks/useSpeechInput.test.mjs drives the supported migration itself.
  assert.doesNotMatch(html, /Voice input|Stop dictation|aria-pressed/);
});

test("every locale ships the dictation strings", () => {
  const keys = [
    "chat.speechDictate",
    "chat.speechStop",
    "chat.speechListening",
    "chat.speechPermissionDenied",
    "chat.speechPermissionHint",
    "chat.speechInsecure",
    "chat.speechNoMic",
    "chat.speechNetwork",
    "chat.speechUnavailable",
    "chat.speechRetry",
  ];
  for (const messages of [enLocale.messages, zhCNLocale.messages, zhTWLocale.messages]) {
    for (const key of keys) {
      assert.equal(typeof messages[key], "string", key);
      assert.ok(messages[key].length > 0, `${key} is not empty`);
    }
  }
  // Spot checks against copy-paste slip-ups; full parity is registry.test.mjs's.
  assert.equal(zhCNLocale.messages["chat.speechStop"], "停止听写");
  assert.equal(zhTWLocale.messages["chat.speechStop"], "停止聽寫");
});
