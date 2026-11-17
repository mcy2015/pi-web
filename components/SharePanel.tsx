"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { formatRelativeTime } from "@/lib/i18n/format";
import {
  DEFAULT_SHARE_DURATION_DAYS,
  isShareDurationDays,
  type ShareDurationDays,
} from "@/lib/share-types";

/**
 * A session row's "Share…" body (components/SessionSidebar.tsx, a SidebarMenu
 * custom body): the disclosure a session without a share shows, and the link
 * with Copy / Refresh content / Stop sharing once one exists. The share state
 * is read when the panel opens and written through /api/sessions/[id]/share;
 * the public page itself is not this panel's. Closing the panel never cancels
 * a request that already went out — only its answer is dropped — so a share
 * created after the panel closed still exists, and the row's next "Share…"
 * shows it.
 */

/** A live share, as GET and POST /api/sessions/[id]/share answer it. */
export interface ShareInfo {
  code: string;
  createdAt: string;
  /** ISO UTC; null = permanent. */
  expiresAt: string | null;
  /** The tier the select opens on, resolved server-side. */
  durationDays: ShareDurationDays;
  title: string;
}

/** The POST body a create or refresh sends for a duration. */
export function shareCreateBody(durationDays: ShareDurationDays): string {
  return JSON.stringify({ durationDays });
}

/** The choices a share's duration select offers, in display order. */
export const SHARE_DURATION_OPTIONS: { value: ShareDurationDays; labelKey: string }[] = [
  { value: 1, labelKey: "share.duration1Day" },
  { value: 7, labelKey: "share.duration7Days" },
  { value: 30, labelKey: "share.duration30Days" },
  { value: null, labelKey: "share.durationForever" },
];

/** A duration as its select's option value ("" = permanent). */
export function shareDurationOptionValue(duration: ShareDurationDays): string {
  return duration === null ? "" : String(duration);
}

/** Back from the select: the value is one of the four options or the default. */
export function parseShareDurationOptionValue(value: string): ShareDurationDays {
  const duration: unknown = value === "" ? null : Number(value);
  return isShareDurationDays(duration) ? duration : DEFAULT_SHARE_DURATION_DAYS;
}

export type SharePanelState =
  | { status: "loading" }
  | { status: "load-failed"; error: string }
  | { status: "unshared" }
  | { status: "shared"; share: ShareInfo };

/** The public link of a share code: the instance's origin plus /share/<code>. */
export function shareLinkUrl(origin: string, code: string): string {
  return `${origin}/share/${code}`;
}

/**
 * Why creating or refreshing a share failed, as a message key and its
 * parameters: the size limit says so in its own words, anything else shows
 * the server's error (or its status when it sent none).
 */
export function shareCreateFailure(data: { error?: string; code?: string }, status: number): { key: string; params?: { error: string } } {
  if (data.code === "too_large" || data.error === "too_large") return { key: "share.tooLarge" };
  return { key: "share.createError", params: { error: data.error ?? `HTTP ${status}` } };
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The panel: fetches the share state (and the session's message count for the
 * disclosure) when it opens, then creates, refreshes or stops the share. The
 * view is `SharePanelView`, exported for tests.
 */
export function SharePanel({
  sessionId,
  origin,
  fetchImpl,
  onCopied,
  onStopped,
}: {
  sessionId: string;
  /** The share link's origin; defaults to the page's own. */
  origin?: string;
  /** Sent instead of the global fetch, so tests never reach the network. */
  fetchImpl?: typeof fetch;
  /** The copy toast. */
  onCopied: () => void;
  /** The toast once the link is gone. */
  onStopped: () => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<SharePanelState>({ status: "loading" });
  const [busy, setBusy] = useState<"create" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopArmed, setStopArmed] = useState(false);
  const [duration, setDuration] = useState<ShareDurationDays>(DEFAULT_SHARE_DURATION_DAYS);
  const [messageCount, setMessageCount] = useState<number | null>(null);
  const request = fetchImpl ?? fetch;
  const pageOrigin = origin ?? (typeof window === "undefined" ? "" : window.location.origin);
  // One write at a time: a create and a stop answer for the same share must
  // not interleave.
  const pendingRef = useRef(false);

  // The share as it is now, read when the panel opens. A failure still shows
  // the panel (the disclosure or the link is only a read away from stale).
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    setError(null);
    setStopArmed(false);
    request(`/api/sessions/${encodeURIComponent(sessionId)}/share`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { share?: ShareInfo | null; error?: string };
        if (!active) return;
        if (!response.ok) {
          setState({ status: "load-failed", error: data.error ?? `HTTP ${response.status}` });
          return;
        }
        setState(data.share ? { status: "shared", share: data.share } : { status: "unshared" });
        if (data.share) {
          // The select opens on the share's current tier, resolved server-side
          // (stored durationDays first, inference for old files).
          setDuration(data.share.durationDays);
        }
      })
      .catch((reason: unknown) => {
        if (active) setState({ status: "load-failed", error: errorText(reason) });
      });
    return () => {
      active = false;
    };
  }, [request, sessionId]);

  // The disclosure's summary: the session's own size (GET /api/sessions/[id]'s
  // info.messageCount). A failure only drops the line, never the panel.
  useEffect(() => {
    let active = true;
    request(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { info?: { messageCount?: number } | null };
        if (!active || !response.ok || typeof data.info?.messageCount !== "number") return;
        setMessageCount(data.info.messageCount);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [request, sessionId]);

  // Create and Refresh content are the same POST: the route creates the share
  // or replaces its snapshot with the session as it is now.
  const create = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setBusy("create");
    setError(null);
    request(`/api/sessions/${encodeURIComponent(sessionId)}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: shareCreateBody(duration),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { code?: string; createdAt?: string; expiresAt?: string | null; durationDays?: ShareDurationDays; title?: string; error?: string };
        if (!activeCreateOk(data)) {
          const { key, params } = shareCreateFailure(data, response.status);
          setError(t(key, params));
          return;
        }
        setState({ status: "shared", share: { code: data.code, createdAt: data.createdAt, expiresAt: data.expiresAt, durationDays: data.durationDays, title: data.title } });
        setStopArmed(false);
      })
      .catch((reason: unknown) => {
        setError(t("share.createError", { error: errorText(reason) }));
      })
      .finally(() => {
        pendingRef.current = false;
        setBusy(null);
      });
  }, [duration, request, sessionId, t]);

  // Stop sharing asks first: the first click only arms the button, the second
  // sends the DELETE that takes the link away.
  const stop = useCallback(() => {
    if (pendingRef.current) return;
    if (!stopArmed) {
      setStopArmed(true);
      return;
    }
    pendingRef.current = true;
    setBusy("stop");
    setError(null);
    request(`/api/sessions/${encodeURIComponent(sessionId)}/share`, { method: "DELETE" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
        if (!response.ok || data.ok !== true) {
          setError(t("share.stopError", { error: data.error ?? `HTTP ${response.status}` }));
          return;
        }
        setState({ status: "unshared" });
        setStopArmed(false);
        setMessageCount(null);
        onStopped();
      })
      .catch((reason: unknown) => {
        setError(t("share.stopError", { error: errorText(reason) }));
      })
      .finally(() => {
        pendingRef.current = false;
        setBusy(null);
      });
  }, [onStopped, request, sessionId, stopArmed, t]);

  const copy = useCallback(() => {
    setState((current) => {
      if (current.status === "shared") {
        void copyText(shareLinkUrl(pageOrigin, current.share.code)).then(() => onCopied(), () => {});
      }
      return current;
    });
  }, [onCopied, pageOrigin]);

  return (
    <SharePanelView
      state={state}
      messageCount={messageCount}
      busy={busy}
      error={error}
      stopArmed={stopArmed}
      duration={duration}
      origin={pageOrigin}
      onCopy={copy}
      onCreate={create}
      onRefresh={create}
      onStop={stop}
      onDurationChange={setDuration}
    />
  );
}

/** A POST answer a share can be built from. `expiresAt` may be null (permanent). */
function activeCreateOk(data: { code?: string; createdAt?: string; expiresAt?: string | null; durationDays?: ShareDurationDays; title?: string }): data is { code: string; createdAt: string; expiresAt: string | null; durationDays: ShareDurationDays; title: string } {
  return typeof data.code === "string"
    && typeof data.createdAt === "string"
    && (data.expiresAt === null || typeof data.expiresAt === "string")
    && isShareDurationDays(data.durationDays)
    && typeof data.title === "string";
}

/** The panel in any state, without the fetches; exported for tests. */
export function SharePanelView({
  state,
  messageCount,
  busy,
  error,
  stopArmed,
  duration,
  origin,
  onCopy,
  onCreate,
  onRefresh,
  onStop,
  onDurationChange,
}: {
  state: SharePanelState;
  messageCount: number | null;
  busy: "create" | "stop" | null;
  error: string | null;
  stopArmed: boolean;
  /** The duration the select shows; both states share one control. */
  duration: ShareDurationDays;
  origin: string;
  onCopy: () => void;
  onCreate: () => void;
  onRefresh: () => void;
  onStop: () => void;
  onDurationChange: (duration: ShareDurationDays) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="sidebar-share-panel">
      <div className="sidebar-menu-header">{t("share.title")}</div>
      {state.status === "loading" && (
        <p role="status" className="sidebar-share-status">{t("sidebar.loading")}</p>
      )}
      {state.status === "load-failed" && (
        <div role="alert" className="sidebar-share-error">{t("share.loadError", { error: state.error })}</div>
      )}
      {state.status === "unshared" && (
        <>
          <p className="sidebar-share-text">{t("share.description")}</p>
          {messageCount !== null && (
            <p className="sidebar-share-note">{t("share.summary", { count: messageCount })}</p>
          )}
          <ShareDurationSelect duration={duration} onDurationChange={onDurationChange} label={t("share.durationLabel")} />
          <div className="sidebar-share-buttons">
            <button
              type="button"
              className="sidebar-share-create"
              disabled={busy !== null}
              data-sidebar-menu-autofocus=""
              onClick={onCreate}
            >
              {busy === "create" ? t("share.creating") : t("share.create")}
            </button>
          </div>
        </>
      )}
      {state.status === "shared" && (
        <>
          <div className="sidebar-share-link-label">{t("share.linkLabel")}</div>
          <code className="sidebar-share-link">{shareLinkUrl(origin, state.share.code)}</code>
          <ShareValidityLine expiresAt={state.share.expiresAt} />
          {/* The select says what a Refresh would roll to; the line above says
              what the link is now — each fact once. */}
          <ShareDurationSelect duration={duration} onDurationChange={onDurationChange} label={t("share.durationLabel")} />
          <div className="sidebar-share-buttons">
            <button type="button" className="sidebar-share-copy" data-sidebar-menu-autofocus="" onClick={onCopy}>
              {t("share.copy")}
            </button>
            <button type="button" className="sidebar-share-refresh" disabled={busy !== null} onClick={onRefresh}>
              {busy === "create" ? t("share.creating") : t("share.refresh")}
            </button>
          </div>
          <div className="sidebar-share-buttons">
            <button
              type="button"
              className={`sidebar-share-stop${stopArmed ? " is-armed" : ""}`}
              disabled={busy !== null}
              onClick={onStop}
            >
              {stopArmed ? t("share.confirmStop") : t("share.stop")}
            </button>
          </div>
        </>
      )}
      {error && <div role="alert" className="sidebar-share-error">{error}</div>}
    </div>
  );
}

/** The one duration control both panel states share: a label plus a native
 * select (a segmented control would not fit the menu's narrow body). */
function ShareDurationSelect({ duration, onDurationChange, label }: {
  duration: ShareDurationDays;
  onDurationChange: (duration: ShareDurationDays) => void;
  label: string;
}) {
  const { t } = useI18n();
  return (
    <div className="sidebar-share-duration">
      <span className="sidebar-share-duration-label">{label}</span>
      <select
        className="sidebar-share-duration-select"
        aria-label={label}
        value={shareDurationOptionValue(duration)}
        onChange={(event) => onDurationChange(parseShareDurationOptionValue(event.target.value))}
      >
        {SHARE_DURATION_OPTIONS.map((option) => (
          <option key={option.labelKey} value={shareDurationOptionValue(option.value)}>
            {t(option.labelKey)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Whether a parsed expiry timestamp has passed. Module-level so the check
 * stays out of render (react-hooks/purity); the `now` default is for tests. */
function shareMsExpired(ms: number, now = Date.now()): boolean {
  return now >= ms;
}

/** The link's current validity: what it is now, under the link itself. An
 * expired link says so and points at Refresh (this panel's revive entry). */
function ShareValidityLine({ expiresAt }: { expiresAt: string | null }) {
  const { t, locale } = useI18n();
  if (expiresAt === null) return <p className="sidebar-share-note">{t("share.permanent")}</p>;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return null;
  if (shareMsExpired(ms)) {
    return (
      <>
        <p className="sidebar-share-note">{t("share.expired")}</p>
        <p className="sidebar-share-note">{t("share.expiredHint")}</p>
      </>
    );
  }
  return <p className="sidebar-share-note">{t("share.expiresIn", { time: formatRelativeTime(new Date(ms), locale) })}</p>;
}
