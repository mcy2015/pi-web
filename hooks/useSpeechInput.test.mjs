import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// The hook runs against a stand-in for React's hooks, mocked timers and a fake
// SpeechRecognition whose events the test emits by hand, so the restart loop,
// its backoff and every stop path can be played out without a browser.
const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(pathToFileURL(shimPath).href);
const {
  SPEECH_RESTART_DELAY_MS,
  SPEECH_RESTART_BACKOFF_MAX_MS,
  SPEECH_MAX_RESTARTS,
  SPEECH_NO_SPEECH_TIMEOUT_MS,
  speechLangForLocale,
  useSpeechInput,
} = await jiti.import("./useSpeechInput.ts");

let instances = [];
let startShouldThrow = false;
class FakeSpeechRecognition {
  constructor() {
    this.lang = "";
    this.continuous = undefined;
    this.interimResults = undefined;
    this.maxAlternatives = undefined;
    this.calls = [];
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.onspeechstart = null;
    instances.push(this);
  }
  start() {
    this.calls.push("start");
    if (startShouldThrow) {
      startShouldThrow = false;
      throw new Error("already started");
    }
  }
  stop() { this.calls.push("stop"); }
  abort() { this.calls.push("abort"); }
  result(items, resultIndex = 0) {
    this.onresult?.({
      resultIndex,
      results: items.map(([transcript, isFinal]) => ({ isFinal, length: 1, 0: { transcript } })),
    });
  }
  error(kind) { this.onerror?.({ error: kind }); }
  end() { this.onend?.(); }
}

test.beforeEach(() => {
  instances = [];
  startShouldThrow = false;
  globalThis.window = {};
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
});

test.afterEach(() => {
  mock.timers.reset();
  delete globalThis.window;
});

const install = () => { globalThis.window.SpeechRecognition = FakeSpeechRecognition; };

test("maps locales to BCP-47 speech languages with an English fallback", () => {
  assert.equal(speechLangForLocale("en"), "en-US");
  assert.equal(speechLangForLocale("zh-CN"), "zh-CN");
  assert.equal(speechLangForLocale("zh-TW"), "zh-TW");
  assert.equal(speechLangForLocale("fr"), "en-US");
});

test("without a SpeechRecognition constructor the hook is unsupported and start() is a no-op", () => {
  const view = renderHook(() => useSpeechInput({ lang: "en-US" }));
  view.flush();
  assert.equal(view.result.supported, false);
  view.result.start();
  view.flush();
  assert.equal(view.result.status, "idle");
  assert.equal(instances.length, 0);
});

test("start() configures a session and is idempotent while listening", () => {
  install();
  const view = renderHook(() => useSpeechInput({ lang: "zh-TW" }));
  view.flush();
  view.result.start();
  view.flush();
  assert.equal(view.result.status, "listening");
  assert.equal(instances.length, 1);
  const [rec] = instances;
  assert.equal(rec.lang, "zh-TW");
  assert.equal(rec.continuous, false);
  assert.equal(rec.interimResults, true);
  assert.equal(rec.maxAlternatives, 1);
  assert.deepEqual(rec.calls, ["start"]);
  view.result.start();
  view.flush();
  assert.equal(instances.length, 1, "a second start() does not spawn");
});

test("interim results surface as snapshots; finals go through onFinal once each", () => {
  install();
  const finals = [];
  const view = renderHook(() => useSpeechInput({ lang: "en-US", onFinal: (segment) => finals.push(segment) }));
  view.result.start();
  const [rec] = instances;
  rec.result([["hello wor", false]]);
  view.flush();
  assert.equal(view.result.interim, "hello wor");
  rec.result([["hello world", true]]);
  view.flush();
  assert.deepEqual(finals, ["hello world"]);
  assert.equal(view.result.interim, "", "a final clears the interim snapshot");
  rec.result([["   ", true]]);
  view.flush();
  assert.deepEqual(finals, ["hello world"], "a whitespace-only final is dropped");
});

test("onend restarts a fresh instance after the restart delay", () => {
  install();
  const view = renderHook(() => useSpeechInput({ lang: "en-US" }));
  view.result.start();
  const [first] = instances;
  first.end();
  view.flush();
  assert.equal(view.result.status, "listening");
  mock.timers.tick(SPEECH_RESTART_DELAY_MS - 1);
  assert.equal(instances.length, 1, "not yet restarted");
  mock.timers.tick(1);
  assert.equal(instances.length, 2);
  assert.ok(first.calls.includes("abort"), "the old instance is aborted");
  assert.deepEqual(instances[1].calls, ["start"]);
  view.flush();
  assert.equal(view.result.status, "listening");
});

test("a not-allowed error stops for good with errorKind permission", () => {
  install();
  const view = renderHook(() => useSpeechInput({ lang: "en-US" }));
  view.result.start();
  const [rec] = instances;
  rec.error("not-allowed");
  view.flush();
  assert.equal(view.result.status, "error");
  assert.equal(view.result.errorKind, "permission");
  mock.timers.tick(60_000);
  assert.equal(instances.length, 1, "no restart after a fatal error");
  rec.end();
  mock.timers.tick(60_000);
  assert.equal(instances.length, 1, "the late end() does not restart either");
});

test("a no-speech error stops cleanly: idle, no error, no restart", () => {
  install();
  const view = renderHook(() => useSpeechInput({ lang: "en-US" }));
  view.result.start();
  const [rec] = instances;
  rec.error("no-speech");
  view.flush();
  assert.equal(view.result.status, "idle");
  assert.equal(view.result.errorKind, null);
  assert.ok(rec.calls.includes("abort"), "the session was torn down");
  mock.timers.tick(60_000);
  assert.equal(instances.length, 1);
});

test("restarts back off doubling to the cap, and six restarts without a result give up", () => {
  install();
  const view = renderHook(() => useSpeechInput({ lang: "en-US" }));
  view.result.start();
  const delays = [SPEECH_RESTART_DELAY_MS, 500, 1000, 2000, 4000, SPEECH_RESTART_BACKOFF_MAX_MS];
  for (const delay of delays) {
    instances.at(-1).end();
    view.flush();
    assert.equal(view.result.status, "listening");
    mock.timers.tick(delay - 1);
    const before = instances.length;
    mock.timers.tick(1);
    assert.equal(instances.length, before + 1, `restarted after ${delay}ms`);
  }
  assert.equal(instances.length, SPEECH_MAX_RESTARTS + 1);
  instances.at(-1).end();
  view.flush();
  assert.equal(view.result.status, "error");
  assert.equal(view.result.errorKind, "unavailable");
  mock.timers.tick(60_000);
  assert.equal(instances.length, SPEECH_MAX_RESTARTS + 1, "no further restarts after giving up");
});

test("a session that reports nothing for the watchdog timeout stops cleanly", () => {
  install();
  const view = renderHook(() => useSpeechInput({ lang: "en-US" }));
  view.result.start();
  const [rec] = instances;
  mock.timers.tick(SPEECH_NO_SPEECH_TIMEOUT_MS - 1);
  view.flush();
  assert.equal(view.result.status, "listening");
  mock.timers.tick(1);
  view.flush();
  assert.equal(view.result.status, "idle");
  assert.equal(view.result.errorKind, null);
  assert.ok(rec.calls.includes("abort"));
});

test("a user stop cancels a pending restart and clears the interim", () => {
  install();
  const view = renderHook(() => useSpeechInput({ lang: "en-US" }));
  view.result.start();
  const [rec] = instances;
  rec.result([["abc", false]]);
  view.flush();
  assert.equal(view.result.interim, "abc");
  rec.end();
  view.result.stop();
  view.flush();
  assert.equal(view.result.status, "idle");
  assert.equal(view.result.interim, "");
  mock.timers.tick(60_000);
  assert.equal(instances.length, 1, "the scheduled restart never fires");
});

test("unmount aborts the session, leaves no timers, and late events do nothing", () => {
  install();
  const view = renderHook(() => useSpeechInput({ lang: "en-US" }));
  view.result.start();
  const [rec] = instances;
  rec.end();
  view.unmount();
  assert.ok(rec.calls.includes("abort"), "the unmount cleanup aborted the engine");
  mock.timers.tick(120_000);
  assert.equal(instances.length, 1, "no restart after unmount");
  rec.end();
  rec.error("network");
  mock.timers.tick(120_000);
  assert.equal(instances.length, 1, "late events have no effect");
});

test("two consecutive network errors stop the loop with errorKind network", () => {
  install();
  const view = renderHook(() => useSpeechInput({ lang: "en-US" }));
  view.result.start();
  let [rec] = instances;
  rec.error("network");
  rec.end();
  mock.timers.tick(SPEECH_RESTART_DELAY_MS);
  assert.equal(instances.length, 2, "one network error still restarts");
  [, rec] = instances;
  rec.error("network");
  rec.end();
  view.flush();
  assert.equal(view.result.status, "error");
  assert.equal(view.result.errorKind, "network");
  mock.timers.tick(60_000);
  assert.equal(instances.length, 2);
});

test("a successful result clears the network window, so a later single network error restarts", () => {
  install();
  const view = renderHook(() => useSpeechInput({ lang: "en-US" }));
  view.result.start();
  let [rec] = instances;
  rec.error("network");
  rec.result([["hi", true]]);
  view.flush();
  rec.end();
  mock.timers.tick(SPEECH_RESTART_DELAY_MS);
  assert.equal(instances.length, 2);
  [, rec] = instances;
  rec.error("network");
  rec.end();
  view.flush();
  assert.equal(view.result.status, "listening", "one network error after a success is not fatal");
  mock.timers.tick(500);
  assert.equal(instances.length, 3);
});

test("a lang switch while listening tears the old session down and respawns with the new lang", () => {
  install();
  const view = renderHook((props) => useSpeechInput(props), { lang: "en-US" });
  view.flush();
  view.result.start();
  const [first] = instances;
  first.end();
  view.rerender({ lang: "zh-CN" });
  assert.equal(instances.length, 2);
  assert.ok(first.calls.includes("abort"), "the old instance is aborted");
  assert.equal(instances[1].lang, "zh-CN");
  view.flush();
  assert.equal(view.result.status, "listening");
  mock.timers.tick(60_000);
  assert.equal(instances.length, 2, "the old session's restart timer was cleared");
});

test("a start() that throws fails fast as unavailable instead of listening silently", () => {
  install();
  startShouldThrow = true;
  const view = renderHook(() => useSpeechInput({ lang: "en-US" }));
  view.result.start();
  view.flush();
  assert.equal(view.result.status, "error");
  assert.equal(view.result.errorKind, "unavailable");
  assert.equal(instances.length, 1);
  mock.timers.tick(60_000);
  assert.equal(instances.length, 1, "no retry loop after a refused start");
});

test("supported migrates from false to true once the hydration effect ran", () => {
  install();
  const seen = [];
  const view = renderHook(() => {
    const result = useSpeechInput({ lang: "en-US" });
    seen.push(result.supported);
    return result;
  });
  assert.equal(seen[0], false, "the first render, before effects, says unsupported");
  view.flush();
  assert.equal(view.result.supported, true);
});
