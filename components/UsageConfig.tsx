"use client";

// Settings › Usage: read-only aggregates of the local session history
// (GET /api/usage). Overview cards, activity metrics, a daily-token trend
// chart, a per-day heatmap and bar lists for models, tools and projects, with
// a time-range switch that only re-merges server-side cached buckets.

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatActiveDuration, formatCompactCount, formatCostShort } from "@/lib/session-stats-format";
import { shortenPath } from "@/lib/display-path";
import { USAGE_RANGE_VALUES, type UsageRangeDays, type UsageSnapshot } from "@/lib/usage-types";
import { ConfigButton, ConfigEmptyState, ConfigNotice, ConfigSectionTitle } from "./SettingsUi";
import { UsageBarList, UsageHeatmap, UsageTrendChart } from "./usage-charts";

function percentText(ratio: number | null): string {
  return ratio === null ? "—" : `${Math.round(ratio * 100)}%`;
}

export function UsageConfig() {
  const { t } = useI18n();
  const [range, setRange] = useState<UsageRangeDays>("all");
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async (nextRange: UsageRangeDays, force: boolean) => {
    const id = ++requestId.current;
    if (force) setRefreshing(true);
    setError(false);
    try {
      const params = new URLSearchParams({ range: String(nextRange), ...(force ? { force: "1" } : {}) });
      const res = await fetch(`/api/usage?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as UsageSnapshot;
      if (requestId.current !== id) return;
      setSnapshot(body);
      setLoading(false);
    } catch {
      if (requestId.current !== id) return;
      setError(true);
      setLoading(false);
    } finally {
      if (requestId.current === id) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(range, false);
  }, [range, load]);

  const isEmpty = snapshot !== null && snapshot.overview.messages === 0 && snapshot.daily.every((day) => day.total === 0);
  const showHeatmap = range !== 7 && snapshot !== null && snapshot.daily.length > 7;

  return (
    <div className="settings-usage">
      <div className="usage-header">
        <ConfigSectionTitle>{t("settings.usage.sectionTitle")}</ConfigSectionTitle>
        <div className="usage-controls">
          <div className="usage-range-group" role="group" aria-label={t("settings.usage.rangeLabel")}>
            {USAGE_RANGE_VALUES.map((value) => (
              <ConfigButton
                key={String(value)}
                variant="ghost"
                aria-pressed={range === value}
                onClick={() => setRange(value)}
              >
                {value === "all" ? t("settings.usage.rangeAll") : t(`settings.usage.range${value}`)}
              </ConfigButton>
            ))}
          </div>
          <ConfigButton variant="ghost" onClick={() => void load(range, true)} disabled={refreshing}>
            {t("settings.usage.refresh")}
          </ConfigButton>
        </div>
      </div>
      <p className="settings-general-description">{t("settings.usage.sectionDescription")}</p>

      {loading && <div className="usage-loading">{t("i18n.loading")}</div>}

      {!loading && error && (
        <ConfigNotice
          action={
            <ConfigButton variant="ghost" onClick={() => void load(range, true)}>{t("settings.usage.retry")}</ConfigButton>
          }
        >
          {t("settings.usage.error")}
        </ConfigNotice>
      )}

      {!loading && !error && isEmpty && (
        <ConfigEmptyState>
          <strong>{t("settings.usage.empty")}</strong>
          {t("settings.usage.emptyHint")}
        </ConfigEmptyState>
      )}

      {!loading && !error && snapshot !== null && !isEmpty && (
        <>
          <section className="settings-general-section">
            <div className="usage-cards">
              <div className="usage-card">
                <span className="usage-card-label">{t("settings.usage.totalTokens")}</span>
                <strong className="usage-card-value">{formatCompactCount(snapshot.overview.tokens.total)}</strong>
                <span className="usage-card-detail">
                  {`${t("settings.usage.input")} ${formatCompactCount(snapshot.overview.tokens.input)} · ${t("settings.usage.output")} ${formatCompactCount(snapshot.overview.tokens.output)} · ${t("settings.usage.cacheRead")} ${formatCompactCount(snapshot.overview.tokens.cacheRead)} · ${t("settings.usage.cacheWrite")} ${formatCompactCount(snapshot.overview.tokens.cacheWrite)}`}
                </span>
              </div>
              <div className="usage-card">
                <span className="usage-card-label">{t("settings.usage.cost")}</span>
                <strong className="usage-card-value">{formatCostShort(snapshot.overview.cost) ?? "$0"}</strong>
              </div>
              <div className="usage-card">
                <span className="usage-card-label">{t("settings.usage.sessions")}</span>
                <strong className="usage-card-value">{formatCompactCount(snapshot.overview.sessions)}</strong>
                <span className="usage-card-detail">{`${formatCompactCount(snapshot.overview.messages)} ${t("settings.usage.messages").toLowerCase()}`}</span>
              </div>
              <div className="usage-card">
                <span className="usage-card-label">{t("settings.usage.activeDays")}</span>
                <strong className="usage-card-value">{snapshot.overview.activeDays}</strong>
              </div>
              <div className="usage-card">
                <span className="usage-card-label">{t("settings.usage.activeTime")}</span>
                <strong className="usage-card-value">{formatActiveDuration(snapshot.overview.totalActiveMs)}</strong>
              </div>
              <div className="usage-card">
                <span className="usage-card-label">{t("settings.usage.topModel")}</span>
                <strong className="usage-card-value usage-card-model" title={snapshot.overview.topModel?.model ?? undefined}>
                  {snapshot.overview.topModel ? snapshot.overview.topModel.model : "—"}
                </strong>
                {snapshot.overview.topModel && (
                  <span className="usage-card-detail">{`${t("settings.usage.favoriteModelShare")} ${percentText(snapshot.overview.topModel.share)}`}</span>
                )}
              </div>
            </div>
            <div className="usage-metrics">
              <span>{`${t("settings.usage.currentStreak")} ${snapshot.activity.currentStreakDays} ${t("settings.usage.daysUnit")}`}</span>
              <span>{`${t("settings.usage.longestStreak")} ${snapshot.activity.longestStreakDays} ${t("settings.usage.daysUnit")}`}</span>
              <span>{`${t("settings.usage.cacheHitRate")} ${percentText(snapshot.activity.cacheHitRate)}`}</span>
              {snapshot.activity.peakHour !== null && (
                <span>{`${t("settings.usage.peakHour")} ${snapshot.activity.peakHour}:00–${snapshot.activity.peakHour}:59`}</span>
              )}
            </div>
          </section>

          <section className="settings-general-section">
            <ConfigSectionTitle>{t("settings.usage.dailyTrend")}</ConfigSectionTitle>
            <UsageTrendChart daily={snapshot.daily} formatCount={formatCompactCount} title={t("settings.usage.dailyTrend")} />
            {showHeatmap && (
              <>
                <ConfigSectionTitle>{t("settings.usage.heatmap")}</ConfigSectionTitle>
                <UsageHeatmap daily={snapshot.daily} formatCount={formatCompactCount} />
              </>
            )}
          </section>

          <section className="settings-general-section">
            <ConfigSectionTitle>{t("settings.usage.models")}</ConfigSectionTitle>
            <UsageBarList
              items={snapshot.models.map((row) => ({
                key: row.model,
                label: row.model === "unknown" ? t("settings.usage.unknownModel") : row.model,
                value: row.total,
                hint: formatCostShort(row.cost) ?? undefined,
              }))}
              formatValue={formatCompactCount}
            />
          </section>

          {snapshot.tools.length > 0 && (
            <section className="settings-general-section">
              <ConfigSectionTitle>{t("settings.usage.tools")}</ConfigSectionTitle>
              <UsageBarList
                items={snapshot.tools.map((row) => ({ key: row.name, label: row.name, value: row.count }))}
                formatValue={(count) => `${formatCompactCount(count)} ${t("settings.usage.timesUnit")}`}
              />
            </section>
          )}

          {snapshot.projects.length > 0 && (
            <section className="settings-general-section">
              <ConfigSectionTitle>{t("settings.usage.projects")}</ConfigSectionTitle>
              <UsageBarList
                items={snapshot.projects.map((row) => ({
                  key: row.cwd,
                  label: shortenPath(row.cwd),
                  value: row.total,
                  hint: `${row.sessions} ${t("settings.usage.sessions").toLowerCase()}`,
                }))}
                formatValue={formatCompactCount}
              />
            </section>
          )}

          <p className="usage-footnote">{t("settings.usage.subagentsIncluded")}</p>
        </>
      )}
    </div>
  );
}
