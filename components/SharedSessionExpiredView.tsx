"use client";

import { useI18n } from "@/hooks/useI18n";
import { formatRelativeTime } from "@/lib/i18n/format";

// The public share page's expired state: the link still resolves (not a 404),
// but the snapshot behind it is no longer served. Only the expiry time is
// shown — no title, code or content — so a stale link leaks nothing about the
// session it once exposed. Renewing the share restores the same URL at once.
export function SharedSessionExpiredView({ expiresAt }: { expiresAt: string | null }) {
  const { t, locale } = useI18n();
  const when = (() => {
    if (!expiresAt) return null;
    const ms = Date.parse(expiresAt);
    return Number.isFinite(ms) ? formatRelativeTime(new Date(ms), locale) : null;
  })();
  return (
    <div className="shared-session shared-session-expired">
      <header className="shared-session-header">
        <h1>{t("sharePage.expiredTitle")}</h1>
        <div className="shared-session-meta">
          {when && <span>{t("sharePage.expiredWhen", { time: when })}</span>}
        </div>
      </header>
      <main className="shared-session-messages">
        <p className="shared-session-expired-body">{t("sharePage.expiredBody")}</p>
      </main>
    </div>
  );
}
