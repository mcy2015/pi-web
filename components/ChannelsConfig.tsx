"use client";

// Settings › Channels: one section per channel (today only Telegram) in the
// shared split view — the sidebar lists the channels, the detail pane edits
// the selected one. Telegram's pane: token (write-only, shown as a last-4
// hint), the enable switch, the default cwd, and the chat allowlist.
// Pairing works through the last unknown chat: message the bot, it is
// ignored but recorded, then allowed here with one click.

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
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
  ConfigFooter,
  ConfigFooterStatus,
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
import type { TelegramStatus } from "@/lib/telegram/types";

interface StatusLine {
  kind: "ok" | "error" | "info";
  message: string;
}

/** The sidebar row's state, in the MCP rows' vocabulary. */
function channelRowState(status: TelegramStatus): { tone: "on" | "off" | "error"; badge: string } {
  if (!status.config.tokenSet) return { tone: "off", badge: "channels.badge.unconfigured" };
  if (!status.config.enabled) return { tone: "off", badge: "channels.badge.off" };
  if (status.lastError) return { tone: "error", badge: "channels.badge.error" };
  return { tone: "on", badge: "channels.badge.on" };
}

function statusDot(tone: "on" | "off" | "error"): { active?: boolean; color?: string } {
  if (tone === "on") return { active: true };
  if (tone === "off") return { active: false };
  return { color: "#ef4444" };
}

async function postChannels(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: res.ok, error: payload.error };
}

export function ChannelsConfig({ embedded = true, onClose }: { embedded?: boolean; onClose?: () => void }) {
  const close = () => onClose?.();
  const { t } = useI18n();
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [cwdInput, setCwdInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [line, setLine] = useState<StatusLine | null>(null);
  const cwdTouched = useRef(false);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/channels", { cache: "no-store" });
      const payload = await res.json() as TelegramStatus & { error?: string };
      if (!res.ok || payload.error) {
        setLoadError(payload.error ?? `HTTP ${res.status}`);
        return;
      }
      setStatus(payload);
      setLoadError(null);
      if (!cwdTouched.current) setCwdInput(payload.config.defaultCwd ?? "");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void reload();
    const poll = setInterval(() => void reload(), 5_000);
    return () => clearInterval(poll);
  }, [reload]);

  const run = useCallback(async (key: string, body: Record<string, unknown>, success: () => StatusLine | null) => {
    setBusy(key);
    setLine(null);
    const result = await postChannels(body);
    setBusy(null);
    if (!result.ok) {
      setLine({ kind: "error", message: result.error ?? t("telegram.actionFailed") });
      return;
    }
    const next = success();
    if (next) setLine(next);
    await reload();
  }, [reload, t]);

  const { config } = status ?? {};

  return (
    <ConfigPanelShell
      embedded={embedded}
      title={t("settings.channels")}
      closeLabel={t("i18n.close")}
      onClose={close}
    >
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
            {loadError && !status ? (
              <div role="alert" className="config-sidebar-message is-error">
                {t("channels.loadFailed", { error: loadError })}
              </div>
            ) : !status ? (
              <div className="config-sidebar-message">{t("i18n.loading")}</div>
            ) : (
              <div className="config-sidebar-group">
                <ConfigSidebarGroupLabel>{t("channels.group")}</ConfigSidebarGroupLabel>
                {(() => {
                  const row = channelRowState(status);
                  return (
                    <ConfigSidebarItem
                      active
                      aria-label={`Telegram — ${t(row.badge)}`}
                    >
                      <ConfigStatusDot {...statusDot(row.tone)} />
                      <ConfigSidebarText className="is-grow">Telegram</ConfigSidebarText>
                      <span className={`mcp-sidebar-badge${row.tone === "error" ? " is-error" : ""}`}>
                        {t(row.badge)}
                      </span>
                    </ConfigSidebarItem>
                  );
                })()}
              </div>
            )}
          </ConfigSidebarList>
        </ConfigSidebar>

        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {!status || !config ? null : (
              <>
                {line && (
                  <ConfigNotice>{line.message}</ConfigNotice>
                )}
                {status.lastError && (
                  <ConfigNotice>{t("telegram.loopError", { error: status.lastError })}</ConfigNotice>
                )}

                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    <ConfigDetailTitle>Telegram</ConfigDetailTitle>
                  </ConfigDetailHeaderInfo>
                  <ConfigDetailActions>
                    <ConfigSwitch
                      checked={config.enabled}
                      disabled={!config.tokenSet || busy !== null}
                      label={t("telegram.enabledLabel")}
                      onChange={(enabled) => void run("enabled", { action: "set-enabled", enabled }, () => null)}
                    />
                  </ConfigDetailActions>
                </ConfigDetailHeader>

                {!config.tokenSet && (
                  <ConfigNotice>{t("telegram.setupHint")}</ConfigNotice>
                )}

                <ConfigDetailGrid>
                  <ConfigDetailGridRow label={t("telegram.botStatus")}>
                    {status.running
                      ? t("telegram.connected", { bot: status.botUsername ?? "" })
                      : t("telegram.notConnected")}
                  </ConfigDetailGridRow>
                  <ConfigDetailGridRow label={t("telegram.tokenLabel")}>
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      className="mcp-add-input"
                      placeholder={config.tokenSet
                        ? t("telegram.tokenPlaceholder", { hint: config.tokenHint ?? "" })
                        : "1234567890:AA…"}
                      aria-label={t("telegram.tokenLabel")}
                      value={tokenInput}
                      onChange={(event) => setTokenInput(event.target.value)}
                    />
                  </ConfigDetailGridRow>
                </ConfigDetailGrid>
                <ConfigDetailActions>
                  <ConfigButton
                    size="small"
                    disabled={tokenInput.trim() === "" || busy !== null}
                    onClick={() => void run("token", { action: "set-token", token: tokenInput.trim() }, () => {
                      setTokenInput("");
                      return { kind: "ok", message: t("telegram.tokenSaved") };
                    })}
                  >
                    {t("telegram.tokenSave")}
                  </ConfigButton>
                  {config.tokenSet && (
                    <ConfigButton
                      size="small"
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => void run("remove-token", { action: "remove-token" }, () => ({ kind: "info", message: t("telegram.tokenRemoved") }))}
                    >
                      {t("telegram.tokenRemove")}
                    </ConfigButton>
                  )}
                </ConfigDetailActions>

                <ConfigSectionTitle>{t("telegram.chatsHeading")}</ConfigSectionTitle>
                <ConfigDetailHeaderInfo>{t("telegram.chatsDescription")}</ConfigDetailHeaderInfo>

                {status.lastUnknownChat && (
                  <ConfigNotice
                    action={
                      <ConfigButton
                        size="small"
                        disabled={busy !== null || config.allowedChats.some((chat) => chat.id === status.lastUnknownChat?.id)}
                        onClick={() => void run("allow", {
                          action: "allow-chat",
                          chatId: status.lastUnknownChat?.id,
                          title: status.lastUnknownChat?.title,
                        }, () => ({ kind: "ok", message: t("telegram.chatAllowed") }))}
                      >
                        {t("telegram.allowChat")}
                      </ConfigButton>
                    }
                  >
                    {t("telegram.unknownChatPrompt", {
                      title: status.lastUnknownChat.title ?? t("telegram.unnamedChat"),
                      id: String(status.lastUnknownChat.id),
                    })}
                  </ConfigNotice>
                )}

                {config.allowedChats.length === 0 ? (
                  <ConfigEmptyState>{t("telegram.noChats")}</ConfigEmptyState>
                ) : (
                  <ConfigDetailGrid>
                    {config.allowedChats.map((chat) => (
                      <ConfigDetailGridRow key={chat.id} label={chat.title ?? t("telegram.unnamedChat")} mono>
                        {chat.id}
                        <ConfigDetailActions>
                          <ConfigButton
                            size="small"
                            variant="secondary"
                            disabled={busy !== null}
                            onClick={() => void run(`test-${chat.id}`, { action: "test-send", chatId: chat.id }, () => ({ kind: "ok", message: t("telegram.testSent") }))}
                          >
                            {t("telegram.testSend")}
                          </ConfigButton>
                          <ConfigButton
                            size="small"
                            variant="secondary"
                            disabled={busy !== null}
                            onClick={() => void run(`remove-${chat.id}`, { action: "remove-chat", chatId: chat.id }, () => ({ kind: "info", message: t("telegram.chatRemoved") }))}
                          >
                            {t("telegram.chatRemove")}
                          </ConfigButton>
                        </ConfigDetailActions>
                      </ConfigDetailGridRow>
                    ))}
                  </ConfigDetailGrid>
                )}

                <ConfigSectionTitle>{t("telegram.defaultCwdLabel")}</ConfigSectionTitle>
                <ConfigDetailGrid>
                  <ConfigDetailGridRow label={t("telegram.defaultCwdLabel")}>
                    <input
                      type="text"
                      spellCheck={false}
                      className="mcp-add-input"
                      placeholder={t("telegram.defaultCwdPlaceholder")}
                      aria-label={t("telegram.defaultCwdLabel")}
                      value={cwdInput}
                      onChange={(event) => {
                        cwdTouched.current = true;
                        setCwdInput(event.target.value);
                      }}
                    />
                  </ConfigDetailGridRow>
                </ConfigDetailGrid>
                <ConfigDetailActions>
                  <ConfigButton
                    size="small"
                    disabled={busy !== null}
                    onClick={() => void run("cwd", { action: "set-default-cwd", cwd: cwdInput.trim() }, () => ({ kind: "ok", message: t("telegram.defaultCwdSaved") }))}
                  >
                    {t("telegram.defaultCwdSave")}
                  </ConfigButton>
                </ConfigDetailActions>
              </>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>

      <ConfigFooter
        status={status ? (
          <ConfigFooterStatus
            tone={status.lastError ? "warning" : undefined}
            summary={status.running
              ? t("telegram.connected", { bot: status.botUsername ?? "" })
              : t("telegram.notConnected")}
          />
        ) : undefined}
      >
        {!embedded && onClose && <ConfigButton onClick={onClose}>{t("i18n.close")}</ConfigButton>}
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
