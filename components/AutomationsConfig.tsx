"use client";

// Settings › Automations: the shared split view. The sidebar lists the
// automations (MCP-style rows: a state dot, the name, the next run), the
// detail pane edits the selected one or drafts a new one — schedule editor
// (cron / one-shot / interval) with a live next-run preview, the working
// directory, the prompt, notification and enable switches — plus the recent
// runs, each linking into the session it produced.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { sessionDeepLink } from "@/lib/session-links";
import type { AutomationModel, AutomationRun } from "@/lib/automations/store";
import type { Schedule } from "@/lib/automations/cron-schedule";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailGrid,
  ConfigDetailGridRow,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigFooterStatus,
  ConfigListAction,
  ConfigNotice,
  ConfigPanelShell,
  ConfigSectionTitle,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigSwitch,
} from "./SettingsUi";

type ScheduleKind = "cron" | "at" | "every";

interface Draft {
  name: string;
  kind: ScheduleKind;
  cronExpr: string;
  cronTz: string;
  atLocal: string;
  everyValue: number;
  everyUnit: "minutes" | "hours" | "days";
  cwd: string;
  prompt: string;
  notify: boolean;
}

const EVERY_UNIT_MS: Record<Draft["everyUnit"], number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalInput(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function draftSchedule(draft: Draft): Schedule | null {
  if (draft.kind === "cron") {
    return { kind: "cron", expr: draft.cronExpr.trim(), ...(draft.cronTz.trim() !== "" ? { tz: draft.cronTz.trim() } : {}) };
  }
  if (draft.kind === "at") {
    const atMs = Date.parse(draft.atLocal);
    return Number.isFinite(atMs) ? { kind: "at", atMs } : null;
  }
  const everyMs = Math.round(draft.everyValue) * EVERY_UNIT_MS[draft.everyUnit];
  return Number.isFinite(everyMs) && draft.everyValue > 0 ? { kind: "every", everyMs } : null;
}

function draftFrom(automation: AutomationModel | null): Draft {
  if (!automation) {
    return {
      name: "",
      kind: "every",
      cronExpr: "0 9 * * *",
      cronTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      atLocal: toLocalInput(Date.now() + 3_600_000),
      everyValue: 1,
      everyUnit: "hours",
      cwd: "",
      prompt: "",
      notify: true,
    };
  }
  const schedule = automation.schedule;
  return {
    name: automation.name,
    kind: schedule.kind,
    cronExpr: schedule.kind === "cron" ? schedule.expr : "0 9 * * *",
    cronTz: schedule.kind === "cron" ? schedule.tz ?? "" : "",
    atLocal: schedule.kind === "at" ? toLocalInput(schedule.atMs) : toLocalInput(Date.now() + 3_600_000),
    everyValue: schedule.kind === "every" ? schedule.everyMs / EVERY_UNIT_MS.hours >= 1 && schedule.everyMs % EVERY_UNIT_MS.hours === 0
      ? schedule.everyMs / EVERY_UNIT_MS.hours
      : Math.max(1, Math.round(schedule.everyMs / EVERY_UNIT_MS.minutes))
    : 1,
    everyUnit: schedule.kind === "every" && (schedule.everyMs % EVERY_UNIT_MS.hours !== 0 || schedule.everyMs < EVERY_UNIT_MS.hours) ? "minutes" : "hours",
    cwd: automation.cwd,
    prompt: automation.prompt,
    notify: automation.notify,
  };
}

type Translate = ReturnType<typeof useI18n>["t"];

function formatDue(ms: number | null, t: Translate): string {
  if (ms === null) return t("automations.neverAgain");
  const date = new Date(ms);
  const sameDay = new Date().toDateString() === date.toDateString();
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

async function postAutomations(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; payload?: Record<string, unknown> }> {
  const res = await fetch("/api/automations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, error: typeof payload.error === "string" ? payload.error : undefined, payload };
}

export function AutomationsConfig({ embedded = true, onClose }: { embedded?: boolean; onClose?: () => void }) {
  const { t } = useI18n();
  const [automations, setAutomations] = useState<AutomationModel[] | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null));
  const [preview, setPreview] = useState<{ dueAt: number | null; problem: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const lineTone = useRef<"ok" | "error">("ok");

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/automations", { cache: "no-store" });
      const payload = await res.json() as { automations?: AutomationModel[]; runs?: AutomationRun[]; error?: string };
      if (!res.ok || payload.error) return;
      setAutomations(payload.automations ?? []);
      setRuns(payload.runs ?? []);
    } catch {
      // The next poll retries.
    }
  }, []);

  useEffect(() => {
    void reload();
    const poll = setInterval(() => void reload(), 5_000);
    return () => clearInterval(poll);
  }, [reload]);

  const selectedAutomation = useMemo(
    () => automations?.find((automation) => automation.id === selected) ?? null,
    [automations, selected],
  );

  const pick = useCallback((id: string | null) => {
    setSelected(id);
    setPreview(null);
    setLine(null);
    const automation = automations?.find((entry) => entry.id === id) ?? null;
    setDraft(draftFrom(automation));
  }, [automations]);

  const startNew = useCallback(() => {
    setSelected("new");
    setPreview(null);
    setLine(null);
    setDraft(draftFrom(null));
  }, []);

  // The next-run preview, debounced while the schedule is being edited.
  useEffect(() => {
    const schedule = draftSchedule(draft);
    if (!schedule) return;
    const timer = setTimeout(() => {
      void postAutomations({ action: "preview", schedule }).then((result) => {
        if (!result.ok) {
          setPreview({ dueAt: null, problem: result.error ?? t("automations.actionFailed") });
          return;
        }
        setPreview({
          dueAt: typeof result.payload?.dueAt === "number" ? result.payload.dueAt : null,
          problem: typeof result.payload?.problem === "string" ? result.payload.problem : null,
        });
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, t]);

  const run = useCallback(async (key: string, body: Record<string, unknown>, success: string | null) => {
    setBusy(key);
    setLine(null);
    const result = await postAutomations(body);
    setBusy(null);
    if (!result.ok) {
      lineTone.current = "error";
      setLine(result.error ?? t("automations.actionFailed"));
      return false;
    }
    if (success !== null) {
      lineTone.current = "ok";
      setLine(success);
    }
    await reload();
    return true;
  }, [reload, t]);

  const close = () => onClose?.();
  const editing = selectedAutomation !== null;
  const schedule = draftSchedule(draft);
  const formValid = draft.name.trim() !== "" && draft.cwd.trim() !== "" && draft.prompt.trim() !== "" && schedule !== null && preview?.problem == null;

  return (
    <ConfigPanelShell
      embedded={embedded}
      title={t("settings.automations")}
      closeLabel={t("i18n.close")}
      onClose={close}
    >
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
            {automations === null ? (
              <div className="config-sidebar-message">{t("i18n.loading")}</div>
            ) : automations.length === 0 && selected === null ? (
              <div className="config-sidebar-message is-empty">{t("automations.noneYet")}</div>
            ) : (
              <div className="config-sidebar-group">
                <ConfigSidebarGroupLabel>{t("automations.group")}</ConfigSidebarGroupLabel>
                {automations.map((automation) => (
                  <ConfigSidebarItem
                    key={automation.id}
                    active={selected === automation.id}
                    onClick={() => pick(automation.id)}
                  >
                    <ConfigStatusDot active={automation.enabled && automation.nextDueAt !== null} />
                    <ConfigSidebarText className="is-grow">{automation.name}</ConfigSidebarText>
                    <span className="mcp-sidebar-badge">
                      {automation.enabled
                        ? automation.nextDueAt !== null ? formatDue(automation.nextDueAt, t) : "…"
                        : t("channels.badge.off")}
                    </span>
                  </ConfigSidebarItem>
                ))}
              </div>
            )}
          </ConfigSidebarList>
          <ConfigListAction
            active={selected === "new"}
            onClick={startNew}
          >
            {t("automations.newAction")}
          </ConfigListAction>
        </ConfigSidebar>

        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {(selected === null || selected === "new" || editing) && (
              <>
                {line && (
                  <ConfigNotice>{line}</ConfigNotice>
                )}
                {selected !== null && selected !== "new" && editing && (
                  <ConfigDetailHeader>
                    <ConfigDetailHeaderInfo>
                      <ConfigDetailTitle>{selectedAutomation.name}</ConfigDetailTitle>
                    </ConfigDetailHeaderInfo>
                    <ConfigDetailActions>
                      <ConfigSwitch
                        checked={selectedAutomation.enabled}
                        disabled={busy !== null}
                        label={t("automations.enabledLabel")}
                        onChange={(enabled) => void run(`enabled-${selectedAutomation.id}`, { action: "set-enabled", id: selectedAutomation.id, enabled }, null)}
                      />
                      <ConfigButton
                        size="small"
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => void run(`run-${selectedAutomation.id}`, { action: "run-now", id: selectedAutomation.id }, t("automations.runStarted"))}
                      >
                        {t("automations.runNow")}
                      </ConfigButton>
                      <ConfigButton
                        size="small"
                        variant="danger"
                        disabled={busy !== null}
                        onClick={() => {
                          void run(`delete-${selectedAutomation.id}`, { action: "delete", id: selectedAutomation.id }, t("automations.deleted")).then((ok) => {
                            if (ok) pick(null);
                          });
                        }}
                      >
                        {t("automations.delete")}
                      </ConfigButton>
                    </ConfigDetailActions>
                  </ConfigDetailHeader>
                )}

                <ConfigDetailGrid>
                  <ConfigDetailGridRow label={t("automations.nameLabel")}>
                    <input
                      className="mcp-add-input"
                      type="text"
                      spellCheck={false}
                      aria-label={t("automations.nameLabel")}
                      value={draft.name}
                      onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                    />
                  </ConfigDetailGridRow>
                  <ConfigDetailGridRow label={t("automations.scheduleLabel")}>
                    <div className="automations-schedule">
                      <select
                        aria-label={t("automations.scheduleLabel")}
                        value={draft.kind}
                        onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as ScheduleKind }))}
                      >
                        <option value="cron">{t("automations.kind.cron")}</option>
                        <option value="every">{t("automations.kind.every")}</option>
                        <option value="at">{t("automations.kind.at")}</option>
                      </select>
                      {draft.kind === "cron" && (
                        <>
                          <input
                            className="mcp-add-input"
                            type="text"
                            spellCheck={false}
                            placeholder="0 9 * * 1-5"
                            aria-label={t("automations.cronExpr")}
                            value={draft.cronExpr}
                            onChange={(event) => setDraft((current) => ({ ...current, cronExpr: event.target.value }))}
                          />
                          <input
                            className="mcp-add-input"
                            type="text"
                            spellCheck={false}
                            placeholder="Asia/Shanghai"
                            aria-label={t("automations.cronTz")}
                            value={draft.cronTz}
                            onChange={(event) => setDraft((current) => ({ ...current, cronTz: event.target.value }))}
                          />
                        </>
                      )}
                      {draft.kind === "every" && (
                        <>
                          <input
                            className="automations-number-input"
                            type="number"
                            min={1}
                            aria-label={t("automations.everyValue")}
                            value={draft.everyValue}
                            onChange={(event) => setDraft((current) => ({ ...current, everyValue: Number(event.target.value) }))}
                          />
                          <select
                            aria-label={t("automations.everyUnit")}
                            value={draft.everyUnit}
                            onChange={(event) => setDraft((current) => ({ ...current, everyUnit: event.target.value as Draft["everyUnit"] }))}
                          >
                            <option value="minutes">{t("automations.unit.minutes")}</option>
                            <option value="hours">{t("automations.unit.hours")}</option>
                            <option value="days">{t("automations.unit.days")}</option>
                          </select>
                        </>
                      )}
                      {draft.kind === "at" && (
                        <input
                          className="automations-datetime-input"
                          type="datetime-local"
                          aria-label={t("automations.atTime")}
                          value={draft.atLocal}
                          onChange={(event) => setDraft((current) => ({ ...current, atLocal: event.target.value }))}
                        />
                      )}
                    </div>
                  </ConfigDetailGridRow>
                  <ConfigDetailGridRow label={t("automations.nextRun")}>
                    {preview === null ? "…" : preview.problem !== null
                      ? `⚠️ ${preview.problem}`
                      : `${formatDue(preview.dueAt, t)}`}
                  </ConfigDetailGridRow>
                  <ConfigDetailGridRow label={t("automations.cwdLabel")}>
                    <input
                      className="mcp-add-input"
                      type="text"
                      spellCheck={false}
                      placeholder="/Volumes/…"
                      aria-label={t("automations.cwdLabel")}
                      value={draft.cwd}
                      onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))}
                    />
                  </ConfigDetailGridRow>
                  <ConfigDetailGridRow label={t("automations.notifyLabel")}>
                    <ConfigSwitch
                      checked={draft.notify}
                      label={t("automations.notifyLabel")}
                      onChange={(notify) => setDraft((current) => ({ ...current, notify }))}
                    />
                  </ConfigDetailGridRow>
                </ConfigDetailGrid>

                <ConfigField label={t("automations.promptLabel")}>
                  <textarea
                    className="automations-prompt"
                    rows={5}
                    spellCheck={false}
                    aria-label={t("automations.promptLabel")}
                    value={draft.prompt}
                    onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
                  />
                </ConfigField>
                {selected === "new" && (
                  <ConfigNotice>{t("automations.disclosure")}</ConfigNotice>
                )}
                <ConfigDetailActions>
                  <ConfigButton
                    disabled={!formValid || busy !== null}
                    onClick={() => {
                      const body = {
                        action: editing ? "update" : "create",
                        ...(editing ? { id: selectedAutomation.id } : {}),
                        name: draft.name.trim(),
                        schedule: draftSchedule(draft),
                        cwd: draft.cwd.trim(),
                        prompt: draft.prompt,
                        notify: draft.notify,
                      };
                      void run("save", body, editing ? t("automations.saved") : t("automations.created")).then((ok) => {
                        if (!ok) return;
                        if (!editing) setSelected(null);
                      });
                    }}
                  >
                    {editing ? t("automations.save") : t("automations.create")}
                  </ConfigButton>
                </ConfigDetailActions>
              </>
            )}

            <ConfigSectionTitle>{t("automations.historyTitle")}</ConfigSectionTitle>
            {runs.length === 0 ? (
              <ConfigEmptyState>{t("automations.noRuns")}</ConfigEmptyState>
            ) : (
              <ConfigDetailGrid>
                {runs.slice(0, 12).map((run) => {
                  const automation = automations?.find((entry) => entry.id === run.automationId);
                  const duration = run.finishedAt !== null ? Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000)) : null;
                  return (
                    <ConfigDetailGridRow key={run.id} label={automation?.name ?? t("automations.deletedAutomation")} mono>
                      <ConfigStatusDot {...(run.status === "failed" ? { color: "#ef4444" } : { active: run.status === "done" })} />
                      {t(`automations.run.${run.status}`)}
                      {" · "}
                      {new Date(run.startedAt).toLocaleString()}
                      {duration !== null ? ` · ${duration}s` : ""}
                      {run.sessionId !== null && (
                        <ConfigButton
                          size="small"
                          variant="secondary"
                          onClick={() => window.open(sessionDeepLink(run.sessionId as string), "_blank")}
                        >
                          {t("automations.openSession")}
                        </ConfigButton>
                      )}
                    </ConfigDetailGridRow>
                  );
                })}
              </ConfigDetailGrid>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>

      <ConfigFooter
        status={automations !== null ? (
          <ConfigFooterStatus summary={t("automations.footerCount", { count: automations.length })} />
        ) : undefined}
      >
        {!embedded && close && <ConfigButton onClick={close}>{t("i18n.close")}</ConfigButton>}
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
