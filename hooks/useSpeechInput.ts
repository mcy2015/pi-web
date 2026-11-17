"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The continuous-listening loop restarts each recognition session (they end by
// themselves, continuous=false) after this delay, which doubles per restart
// without any result, capped at SPEECH_RESTART_BACKOFF_MAX_MS.
export const SPEECH_RESTART_DELAY_MS = 250;
export const SPEECH_RESTART_BACKOFF_MAX_MS = 5000;
// Consecutive restarts without a single result before the loop gives up as
// "unavailable" (a broken engine, e.g. Edge/Android's, that only fires onend).
export const SPEECH_MAX_RESTARTS = 6;
// Backstop for an engine that reports nothing at all (a hung Safari session):
// stop cleanly instead of claiming to listen forever.
export const SPEECH_NO_SPEECH_TIMEOUT_MS = 10_000;

export type SpeechStatus =
  | "idle" // not listening (initial, user stop, no-speech clean stop)
  | "listening" // listening, including the gaps between restarts
  | "error"; // stopped on an error; errorKind says why

export type SpeechErrorKind =
  | "permission" // not-allowed / service-not-allowed / insecure context
  | "mic" // audio-capture: no microphone found
  | "network" // network errors, consecutive window of 2
  | "unavailable"; // restarts exhausted or start() refused

// Minimal structural types for the Web Speech API: no
// @types/dom-speech-recognition dependency and no `declare global` — just what
// the hook reads off window and off the events.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const SPEECH_LOCALE_MAP: Record<string, string> = { en: "en-US", "zh-CN": "zh-CN", "zh-TW": "zh-TW" };

export function speechLangForLocale(locale: string): string {
  return SPEECH_LOCALE_MAP[locale] ?? "en-US";
}

export interface UseSpeechInputOptions {
  lang: string; // BCP-47, from speechLangForLocale(locale)
  /** Called once per finalized segment (one segment = one undoable insert). */
  onFinal?: (segment: string) => void;
}

export interface UseSpeechInputResult {
  supported: boolean; // ctor present (false on the server, set after hydration)
  status: SpeechStatus; // "idle" and start() a no-op when unsupported
  errorKind: SpeechErrorKind | null;
  interim: string; // current interim snapshot, display-only
  start: () => void; // idempotent: no effect while listening
  stop: () => void; // user stop: clears interim, back to idle
  toggle: () => void;
}

export function useSpeechInput({ lang, onFinal }: UseSpeechInputOptions): UseSpeechInputResult {
  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState<SpeechStatus>("idle");
  const [errorKind, setErrorKind] = useState<SpeechErrorKind | null>(null);
  const [interim, setInterim] = useState("");

  const wantListeningRef = useRef(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const onFinalRef = useRef(onFinal);
  useEffect(() => { onFinalRef.current = onFinal; });
  // Declared before the respawn effect so their cleanups and runs stay in
  // order: on a lang change this sync runs first, and the respawn below
  // spawns with the new lang.
  const langRef = useRef(lang);
  useEffect(() => { langRef.current = lang; }, [lang]);

  const backoffRef = useRef(SPEECH_RESTART_DELAY_MS);
  const restartsRef = useRef(0); // consecutive restarts with no result; any onresult resets
  const networkErrorsRef = useRef(0); // consecutive network errors; any onresult resets
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearTimers = useCallback(() => {
    clearTimeout(restartTimerRef.current);
    restartTimerRef.current = undefined;
    clearTimeout(watchdogRef.current);
    watchdogRef.current = undefined;
  }, []);

  // A fresh instance per session, with the old one's handlers detached, avoids
  // Chrome's "already started" InvalidStateError races and stale late events.
  const teardownRecognition = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    rec.onspeechstart = null;
    try {
      rec.abort();
    } catch {
      // Already stopped by the engine.
    }
    recRef.current = null;
  }, []);

  const stopInternal = useCallback(() => {
    wantListeningRef.current = false;
    clearTimers();
    teardownRecognition();
    setStatus("idle");
    setInterim("");
  }, [clearTimers, teardownRecognition]);

  const fail = useCallback((kind: SpeechErrorKind) => {
    wantListeningRef.current = false;
    clearTimers();
    teardownRecognition();
    setErrorKind(kind);
    setStatus("error");
    setInterim("");
  }, [clearTimers, teardownRecognition]);

  // stopInternal and spawn reference each other across the restart cycle; the
  // refs break the cycle for useCallback's dependency arrays (the enabledRef
  // pattern of useAudio).
  const stopInternalRef = useRef<() => void>(() => {});
  const spawnRef = useRef<() => void>(() => {});

  const armWatchdog = useCallback(() => {
    clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = undefined;
      stopInternalRef.current();
    }, SPEECH_NO_SPEECH_TIMEOUT_MS);
  }, []);

  const spawn = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor || !wantListeningRef.current) return;
    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = langRef.current;
    // continuous=false + interimResults=true: Safari's iPhone engine never
    // finalizes under continuous=true.
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      // Any result proves the engine alive: the backoff, restart and network
      // counters all reset (a normal utterance restarts between sentences).
      restartsRef.current = 0;
      networkErrorsRef.current = 0;
      backoffRef.current = SPEECH_RESTART_DELAY_MS;
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alternative = result?.[0];
        if (!alternative) continue;
        const transcript = alternative.transcript ?? "";
        if (result.isFinal) {
          const segment = transcript.trim();
          if (segment) onFinalRef.current?.(segment);
        } else {
          interimText += transcript;
        }
      }
      setInterim(interimText);
      armWatchdog();
    };
    rec.onspeechstart = () => {
      armWatchdog();
    };
    rec.onerror = (event) => {
      const kind = event.error;
      if (kind === "not-allowed" || kind === "service-not-allowed") {
        fail("permission");
        return;
      }
      if (kind === "audio-capture") {
        fail("mic");
        return;
      }
      if (kind === "network") {
        // Counted and judged at the following onend (an "aborted" after a
        // user stop must not restart, so onend remains the only spawner).
        networkErrorsRef.current++;
        return;
      }
      if (kind === "no-speech") {
        // Chrome's own silence timeout: stop cleanly, no error banner.
        stopInternalRef.current();
        return;
      }
      // "aborted" and anything else: the onend that follows decides.
    };
    rec.onend = () => {
      if (!wantListeningRef.current) {
        setInterim("");
        return;
      }
      setInterim("");
      restartsRef.current++;
      if (restartsRef.current > SPEECH_MAX_RESTARTS) {
        fail("unavailable");
        return;
      }
      if (networkErrorsRef.current >= 2) {
        fail("network");
        return;
      }
      clearTimers();
      const delay = backoffRef.current;
      backoffRef.current = Math.min(backoffRef.current * 2, SPEECH_RESTART_BACKOFF_MAX_MS);
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = undefined;
        if (!wantListeningRef.current) return;
        teardownRecognition();
        spawnRef.current();
      }, delay);
    };
    try {
      rec.start();
      armWatchdog();
    } catch {
      // A refused start (an "already started" race, a broken engine) must not
      // leave the hook claiming to listen.
      fail("unavailable");
    }
  }, [armWatchdog, clearTimers, fail, teardownRecognition]);

  stopInternalRef.current = stopInternal;
  spawnRef.current = spawn;

  const start = useCallback(() => {
    if (!getSpeechRecognitionCtor()) return;
    if (wantListeningRef.current) return;
    // Chrome reports an insecure origin as not-allowed only after a confusing
    // permission round-trip; say it up front instead.
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      fail("permission");
      return;
    }
    wantListeningRef.current = true;
    restartsRef.current = 0;
    networkErrorsRef.current = 0;
    backoffRef.current = SPEECH_RESTART_DELAY_MS;
    setErrorKind(null);
    setInterim("");
    setStatus("listening");
    spawn();
  }, [fail, spawn]);

  const stop = useCallback(() => {
    stopInternal();
  }, [stopInternal]);

  const toggle = useCallback(() => {
    if (wantListeningRef.current) stopInternal();
    else start();
  }, [start, stopInternal]);

  useEffect(() => {
    setSupported(getSpeechRecognitionCtor() !== null);
  }, []);

  // A locale switch while listening: clear any pending restart timer (it would
  // fire with the old lang, and its watchdog could stop the new session) and
  // respawn with the new one.
  useEffect(() => {
    if (!wantListeningRef.current) return;
    clearTimers();
    teardownRecognition();
    spawn();
  }, [lang, clearTimers, teardownRecognition, spawn]);

  // Unmount: abort, never stop() — stop() waits for a final flush whose
  // events would land after the component is gone.
  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      clearTimers();
      teardownRecognition();
    };
  }, [clearTimers, teardownRecognition]);

  return { supported, status, errorKind, interim, start, stop, toggle };
}
