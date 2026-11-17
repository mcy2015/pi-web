"use client";

// Settings › Shares: the share admin page. One table over GET /api/shares —
// every stored link with its expiry state and whether the session behind it
// still exists — plus the two actions POST /api/shares offers: revoke (one row
// or a selection, sent in parts of the route's id cap) and renew (move a
// link's expiry without re-freezing the session). No split view: there is no
// list-then-detail structure, just the table. The container holds the
// fetches and the confirm state machines; `SharesConfigView` is the pure
// render, exported for tests.

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { formatRelativeTime } from "@/lib/i18n/format";
import { DEFAULT_SHARE_DURATION_DAYS, type ShareDurationDays } from "@/lib/share-types";
import type { ShareAdminItem } from "@/lib/share-admin";
import { parseShareDurationOptionValue, SHARE_DURATION_OPTIONS, shareDurationOptionValue, shareLinkUrl } from "./SharePanel";
import { ConfigButton, ConfigEmptyState, ConfigFooter, ConfigPanelShell } from "./SettingsUi";

interface StatusLine {
  kind: "ok" | "error";
  message: string;
}

/** The most ids one revoke takes (app/api/shares/route.ts); a bigger selection goes in parts. */
const REVOKES_PER_REQUEST = 500;

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The admin page: loads the list when it mounts (and on Refresh), then
 * revokes and renews through POST /api/shares. Works without a project, like
 * Channels and Automations.
 */
export function SharesConfig({
  embedded = true,
  onClose,
  fetchImpl,
}: {
  embedded?: boolean;
  onClose?: () => void;
  /** Sent instead of the global fetch, so tests never reach the network. */
  fetchImpl?: typeof fetch;
}) {
  const { t, locale } = useI18n();
  const request = fetchImpl ?? fetch;
  const [items, setItems] = useState<ShareAdminItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  /** null = idle; "revoke-all" = the batch; `renew:<id>` / `revoke:<id>` = that row. */
  const [busy, setBusy] = useState<string | null>(null);
  const [line, setLine] = useState<StatusLine | null>(null);
  const [revokeArmedRow, setRevokeArmedRow] = useState<string | null>(null);
  const [revokeAllArmed, setRevokeAllArmed] = useState(false);
  const [renewDrafts, setRenewDrafts] = useState<Record<string, ShareDurationDays>>({});

  const reload = useCallback(async () => {
    try {
      const response = await request("/api/shares", { cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { shares?: ShareAdminItem[]; error?: string };
      if (!response.ok || !Array.isArray(payload.shares)) {
        setLoadError(payload.error ?? `HTTP ${response.status}`);
        return;
      }
      const loaded = payload.shares;
      setItems(loaded);
      setLoadError(null);
      setRevokeArmedRow(null);
      setRevokeAllArmed(false);
      setSelected((current) => new Set([...current].filter((id) => loaded.some((item) => item.sessionId === id))));
      setRenewDrafts((current) => {
        // Each row's select opens on its current tier; a draft the user already
        // moved (before pressing Renew) survives a refresh of the list.
        const next: Record<string, ShareDurationDays> = {};
        for (const item of loaded) {
          next[item.sessionId] = current[item.sessionId] ?? item.durationDays;
        }
        return next;
      });
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, [request]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const dropRows = useCallback((ids: ReadonlySet<string>) => {
    setItems((current) => current?.filter((item) => !ids.has(item.sessionId)) ?? current);
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
    setRenewDrafts((current) => {
      const next = { ...current };
      for (const id of ids) delete next[id];
      return next;
    });
    setRevokeArmedRow(null);
    setRevokeAllArmed(false);
  }, []);

  const toggleRow = useCallback((id: string) => {
    // Any selection change disarms the confirm states, as a changed mind.
    setRevokeArmedRow(null);
    setRevokeAllArmed(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setRevokeArmedRow(null);
    setRevokeAllArmed(false);
    setSelected((current) => {
      if (!items || items.length === 0) return current;
      const every = items.every((item) => current.has(item.sessionId));
      return every ? new Set<string>() : new Set(items.map((item) => item.sessionId));
    });
  }, [items]);

  const copyLink = useCallback(async (code: string) => {
    try {
      await copyText(shareLinkUrl(window.location.origin, code));
      setLine({ kind: "ok", message: t("shares.linkCopied") });
    } catch {
      // The clipboard refusing says nothing worth a line.
    }
  }, [t]);

  const renew = useCallback(async (id: string) => {
    if (busy !== null) return;
    const durationDays = renewDrafts[id] ?? DEFAULT_SHARE_DURATION_DAYS;
    setBusy(`renew:${id}`);
    setLine(null);
    try {
      const response = await request("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "renew", sessionId: id, durationDays }),
      });
      const payload = await response.json().catch(() => ({})) as { share?: { expiresAt?: string | null }; error?: string };
      if (!response.ok || !payload.share
        || (payload.share.expiresAt !== null && typeof payload.share.expiresAt !== "string")) {
        setLine({ kind: "error", message: t("shares.renewError", { error: payload.error ?? `HTTP ${response.status}` }) });
        return;
      }
      const expiresAt = payload.share.expiresAt;
      // The row updates in place: same code and title, only the expiry moved.
      setItems((current) => current?.map((item) => item.sessionId === id ? { ...item, expiresAt, expired: false, durationDays } : item) ?? current);
      setRenewDrafts((current) => ({ ...current, [id]: durationDays }));
      setLine({
        kind: "ok",
        message: durationDays === null || expiresAt === null
          ? t("shares.renewedPermanent")
          : t("shares.renewed", { time: formatRelativeTime(expiresAt, locale) }),
      });
    } catch (error) {
      setLine({ kind: "error", message: t("shares.renewError", { error: errorText(error) }) });
    } finally {
      setBusy(null);
    }
  }, [busy, locale, renewDrafts, request, t]);

  // A revoke asks first, like the panel's stop: the first click arms the row's
  // button, the second sends it.
  const revoke = useCallback(async (id: string) => {
    if (busy !== null) return;
    if (revokeArmedRow !== id) {
      setRevokeArmedRow(id);
      return;
    }
    setBusy(`revoke:${id}`);
    setLine(null);
    try {
      const response = await request("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke", ids: [id] }),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; revoked?: string[]; error?: string };
      if (!response.ok || payload.ok !== true) {
        setLine({ kind: "error", message: t("shares.revokeError", { error: payload.error ?? `HTTP ${response.status}` }) });
        return;
      }
      dropRows(new Set(payload.revoked ?? []));
      setLine({ kind: "ok", message: t("shares.revoked", { count: (payload.revoked ?? []).length }) });
    } catch (error) {
      setLine({ kind: "error", message: t("shares.revokeError", { error: errorText(error) }) });
    } finally {
      setBusy(null);
    }
  }, [busy, dropRows, request, revokeArmedRow, t]);

  // The batch revoke asks first too, then sends the selection in parts of the
  // route's id cap (500), like the sidebar's project delete.
  const revokeSelected = useCallback(async () => {
    if (busy !== null || selected.size === 0) return;
    if (!revokeAllArmed) {
      setRevokeAllArmed(true);
      return;
    }
    setBusy("revoke-all");
    setLine(null);
    const ids = [...selected];
    const revoked: string[] = [];
    try {
      let failure: string | null = null;
      for (let start = 0; start < ids.length && failure === null; start += REVOKES_PER_REQUEST) {
        const response = await request("/api/shares", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "revoke", ids: ids.slice(start, start + REVOKES_PER_REQUEST) }),
        });
        const payload = await response.json().catch(() => ({})) as { ok?: boolean; revoked?: string[]; error?: string };
        if (!response.ok || payload.ok !== true) {
          failure = payload.error ?? `HTTP ${response.status}`;
        } else {
          revoked.push(...(payload.revoked ?? []));
        }
      }
      // Whatever went through before a failure is still gone: drop it.
      if (revoked.length > 0) dropRows(new Set(revoked));
      setLine(failure !== null
        ? { kind: "error", message: t("shares.revokeError", { error: failure }) }
        : { kind: "ok", message: t("shares.revoked", { count: revoked.length }) });
    } catch (error) {
      if (revoked.length > 0) dropRows(new Set(revoked));
      setLine({ kind: "error", message: t("shares.revokeError", { error: errorText(error) }) });
    } finally {
      setBusy(null);
    }
  }, [busy, dropRows, request, revokeAllArmed, selected, t]);

  return (
    <SharesConfigView
      embedded={embedded}
      onClose={() => onClose?.()}
      items={items}
      loadError={loadError}
      selected={selected}
      busy={busy}
      line={line}
      revokeArmedRow={revokeArmedRow}
      revokeAllArmed={revokeAllArmed}
      renewDrafts={renewDrafts}
      onToggleRow={toggleRow}
      onToggleAll={toggleAll}
      onRenewDraft={(id, duration) => setRenewDrafts((current) => ({ ...current, [id]: duration }))}
      onRenew={(id) => void renew(id)}
      onRevoke={(id) => void revoke(id)}
      onRevokeSelected={() => void revokeSelected()}
      onReload={() => void reload()}
      onCopyLink={(code) => void copyLink(code)}
    />
  );
}

/** The page without the fetches; exported for tests. */
export function SharesConfigView({
  embedded,
  onClose,
  items,
  loadError,
  selected,
  busy,
  line,
  revokeArmedRow,
  revokeAllArmed,
  renewDrafts,
  onToggleRow,
  onToggleAll,
  onRenewDraft,
  onRenew,
  onRevoke,
  onRevokeSelected,
  onReload,
  onCopyLink,
}: {
  embedded: boolean;
  onClose: () => void;
  items: ShareAdminItem[] | null;
  loadError: string | null;
  selected: ReadonlySet<string>;
  /** null = idle; "revoke-all" = the batch; `renew:<id>` / `revoke:<id>` = that row. */
  busy: string | null;
  line: StatusLine | null;
  /** The row whose Revoke button is armed (its second click sends). */
  revokeArmedRow: string | null;
  /** The batch revoke's armed state. */
  revokeAllArmed: boolean;
  /** Each row's select value; missing falls back to the default tier. */
  renewDrafts: Record<string, ShareDurationDays>;
  onToggleRow: (id: string) => void;
  onToggleAll: () => void;
  onRenewDraft: (id: string, duration: ShareDurationDays) => void;
  onRenew: (id: string) => void;
  onRevoke: (id: string) => void;
  onRevokeSelected: () => void;
  onReload: () => void;
  onCopyLink: (code: string) => void;
}) {
  const { t, locale } = useI18n();
  const allSelected = (items?.length ?? 0) > 0 && items!.every((item) => selected.has(item.sessionId));
  return (
    <ConfigPanelShell
      embedded={embedded}
      title={t("settings.shares")}
      closeLabel={t("i18n.close")}
      onClose={onClose}
    >
      <div className="shares-config">
        <div className="shares-config-head">
          <p className="shares-config-description">{t("shares.description")}</p>
          <ConfigButton size="small" disabled={busy !== null} onClick={onReload}>
            {t("shares.refresh")}
          </ConfigButton>
        </div>

        {line && <div role="status" className={`shares-config-line is-${line.kind}`}>{line.message}</div>}
        {items !== null && loadError !== null && (
          <div role="alert" className="shares-config-line is-error">{t("shares.loadError", { error: loadError })}</div>
        )}

        {items === null && loadError !== null ? (
          <div role="alert" className="shares-config-line is-error">{t("shares.loadError", { error: loadError })}</div>
        ) : items === null ? (
          <div role="status" className="shares-config-loading">{t("i18n.loading")}</div>
        ) : items.length === 0 ? (
          <ConfigEmptyState>{t("shares.empty")}</ConfigEmptyState>
        ) : (
          <>
            <div className="shares-config-count">{t("shares.count", { count: items.length })}</div>
            <div className="shares-table-wrap">
              <table className="shares-table">
                <thead>
                  <tr>
                    <th scope="col" className="shares-table-check">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={onToggleAll}
                        aria-label={t("shares.selectAll")}
                      />
                    </th>
                    <th scope="col">{t("shares.columnSession")}</th>
                    <th scope="col">{t("shares.columnCreated")}</th>
                    <th scope="col">{t("shares.columnValidity")}</th>
                    <th scope="col">{t("shares.columnStatus")}</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const draft = renewDrafts[item.sessionId] ?? DEFAULT_SHARE_DURATION_DAYS;
                    const armed = revokeArmedRow === item.sessionId;
                    return (
                      <tr key={item.sessionId}>
                        <td className="shares-table-check">
                          <input
                            type="checkbox"
                            checked={selected.has(item.sessionId)}
                            onChange={() => onToggleRow(item.sessionId)}
                            aria-label={`${t("shares.selectRow")}: ${item.title}`}
                          />
                        </td>
                        <td className="shares-table-session">
                          {/* The public page needs no login: the owner's shortest way to check a link. */}
                          <a className="shares-table-title" href={`/share/${item.code}`} target="_blank" rel="noreferrer">
                            {item.title}
                          </a>
                          <div className="shares-table-code" title={item.code}>…{item.code.slice(-6)}</div>
                        </td>
                        <td>{formatRelativeTime(item.createdAt, locale)}</td>
                        <td>
                          {item.expiresAt === null
                            ? t("shares.permanent")
                            : item.expired
                              ? t("shares.expiredWhen", { time: formatRelativeTime(item.expiresAt, locale) })
                              : t("shares.expiresIn", { time: formatRelativeTime(item.expiresAt, locale) })}
                        </td>
                        <td className="shares-table-status">
                          {item.expired && <span className="mcp-sidebar-badge is-warning">{t("share.expired")}</span>}
                          {item.orphan && (
                            <span className="mcp-sidebar-badge" title={t("shares.orphanHint")}>{t("shares.orphan")}</span>
                          )}
                        </td>
                        <td className="shares-table-actions">
                          <div className="shares-table-actions-row">
                            <ConfigButton size="small" onClick={() => onCopyLink(item.code)}>
                              {t("shares.copyLink")}
                            </ConfigButton>
                            <select
                              className="shares-duration-select"
                              aria-label={t("share.durationLabel")}
                              value={shareDurationOptionValue(draft)}
                              onChange={(event) => onRenewDraft(item.sessionId, parseShareDurationOptionValue(event.target.value))}
                            >
                              {SHARE_DURATION_OPTIONS.map((option) => (
                                <option key={option.labelKey} value={shareDurationOptionValue(option.value)}>
                                  {t(option.labelKey)}
                                </option>
                              ))}
                            </select>
                            <ConfigButton size="small" disabled={busy !== null} onClick={() => onRenew(item.sessionId)}>
                              {t("shares.renew")}
                            </ConfigButton>
                            <ConfigButton
                              size="small"
                              variant={armed ? "danger" : "secondary"}
                              disabled={busy !== null}
                              onClick={() => onRevoke(item.sessionId)}
                            >
                              {armed ? t("shares.confirmRevoke") : t("shares.revoke")}
                            </ConfigButton>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ConfigFooter>
              <ConfigButton
                variant={revokeAllArmed ? "danger" : "secondary"}
                disabled={selected.size === 0 || busy !== null}
                onClick={onRevokeSelected}
              >
                {revokeAllArmed
                  ? t("shares.confirmRevokeSelected", { count: selected.size })
                  : t("shares.revokeSelected", { count: selected.size })}
              </ConfigButton>
            </ConfigFooter>
          </>
        )}
      </div>
    </ConfigPanelShell>
  );
}
