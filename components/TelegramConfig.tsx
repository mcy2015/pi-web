"use client";

// Settings › Telegram: token (write-only, shown as a last-4 hint), the enable
// switch, the default cwd new chat sessions run in, and the chat allowlist.
// Pairing works through the last unknown chat: message the bot, it is ignored
// but recorded, then allowed here with one click.

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigSwitch } from "./SettingsUi";
import type { TelegramStatus } from "@/lib/telegram/types";

interface StatusLine {
  kind: "ok" | "error" | "info";
  message: string;
}

async function postTelegram(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: res.ok, error: payload.error };
}

export function TelegramConfig() {
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
      const res = await fetch("/api/telegram", { cache: "no-store" });
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
    const result = await postTelegram(body);
    setBusy(null);
    if (!result.ok) {
      setLine({ kind: "error", message: result.error ?? t("telegram.actionFailed") });
      return;
    }
    const next = success();
    if (next) setLine(next);
    await reload();
  }, [reload, t]);

  if (loadError && !status) {
    return <p className="settings-telegram-error" role="alert">{t("telegram.loadFailed", { error: loadError })}</p>;
  }
  if (!status) {
    return <p className="settings-telegram-muted">{t("telegram.loading")}</p>;
  }

  const { config } = status;
  const allowLastUnknown = status.lastUnknownChat
    && !config.allowedChats.some((chat) => chat.id === status.lastUnknownChat?.id);

  return (
    <div className="settings-telegram">
      {line && (
        <p
          role={line.kind === "error" ? "alert" : "status"}
          className={`settings-telegram-line is-${line.kind}`}
        >{line.message}</p>
      )}

      <h3 className="settings-general-heading">{t("telegram.connectionHeading")}</h3>
      <p className="settings-general-description">{t("telegram.connectionDescription")}</p>
      <div className="settings-telegram-row">
        <span>{t("telegram.botStatus")}</span>
        <span className={status.running ? "settings-telegram-ok" : "settings-telegram-muted"}>
          {status.running
            ? t("telegram.connected", { bot: status.botUsername ?? "" })
            : status.lastError
              ? t("telegram.loopError", { error: status.lastError })
              : t("telegram.notConnected")}
        </span>
      </div>

      <div className="settings-telegram-row">
        <label htmlFor="settings-telegram-token">{t("telegram.tokenLabel")}</label>
        <div className="settings-telegram-token">
          <input
            id="settings-telegram-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={config.tokenSet ? t("telegram.tokenPlaceholder", { hint: config.tokenHint ?? "" }) : "1234567890:AA…"}
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
          />
          <button
            type="button"
            disabled={tokenInput.trim() === "" || busy !== null}
            onClick={() => void run("token", { action: "set-token", token: tokenInput.trim() }, () => {
              setTokenInput("");
              return { kind: "ok", message: t("telegram.tokenSaved") };
            })}
          >{t("telegram.tokenSave")}</button>
          {config.tokenSet && (
            <button
              type="button"
              className="settings-telegram-danger"
              disabled={busy !== null}
              onClick={() => void run("remove-token", { action: "remove-token" }, () => ({ kind: "info", message: t("telegram.tokenRemoved") }))}
            >{t("telegram.tokenRemove")}</button>
          )}
        </div>
      </div>

      <div className="settings-telegram-row">
        <span id="settings-telegram-enabled-label">{t("telegram.enabledLabel")}</span>
        <ConfigSwitch
          checked={config.enabled}
          disabled={!config.tokenSet || busy !== null}
          label={t("telegram.enabledLabel")}
          describedBy="settings-telegram-enabled-label"
          onChange={(enabled) => void run("enabled", { action: "set-enabled", enabled }, () => null)}
        />
      </div>

      <h3 className="settings-general-heading">{t("telegram.chatsHeading")}</h3>
      <p className="settings-general-description">{t("telegram.chatsDescription")}</p>

      <div className="settings-telegram-row">
        <label htmlFor="settings-telegram-cwd">{t("telegram.defaultCwdLabel")}</label>
        <div className="settings-telegram-token">
          <input
            id="settings-telegram-cwd"
            type="text"
            spellCheck={false}
            placeholder={t("telegram.defaultCwdPlaceholder")}
            value={cwdInput}
            onChange={(event) => {
              cwdTouched.current = true;
              setCwdInput(event.target.value);
            }}
          />
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("cwd", { action: "set-default-cwd", cwd: cwdInput.trim() }, () => ({ kind: "ok", message: t("telegram.defaultCwdSaved") }))}
          >{t("telegram.defaultCwdSave")}</button>
        </div>
      </div>

      {config.allowedChats.length === 0 ? (
        <p className="settings-telegram-muted">{t("telegram.noChats")}</p>
      ) : (
        <ul className="settings-telegram-chats">
          {config.allowedChats.map((chat) => (
            <li key={chat.id}>
              <span className="settings-telegram-chat-name">{chat.title ?? t("telegram.unnamedChat")}</span>
              <code>{chat.id}</code>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void run(`test-${chat.id}`, { action: "test-send", chatId: chat.id }, () => ({ kind: "ok", message: t("telegram.testSent") }))}
              >{t("telegram.testSend")}</button>
              <button
                type="button"
                className="settings-telegram-danger"
                disabled={busy !== null}
                onClick={() => void run(`remove-${chat.id}`, { action: "remove-chat", chatId: chat.id }, () => ({ kind: "info", message: t("telegram.chatRemoved") }))}
              >{t("telegram.chatRemove")}</button>
            </li>
          ))}
        </ul>
      )}

      {status.lastUnknownChat && (
        <div className="settings-telegram-unknown" role="note">
          <p>
            {t("telegram.unknownChatPrompt", {
              title: status.lastUnknownChat.title ?? t("telegram.unnamedChat"),
              id: String(status.lastUnknownChat.id),
            })}
          </p>
          <button
            type="button"
            disabled={busy !== null || !allowLastUnknown}
            onClick={() => void run("allow", {
              action: "allow-chat",
              chatId: status.lastUnknownChat?.id,
              title: status.lastUnknownChat?.title,
            }, () => ({ kind: "ok", message: t("telegram.chatAllowed") }))}
          >{t("telegram.allowChat")}</button>
        </div>
      )}
    </div>
  );
}
