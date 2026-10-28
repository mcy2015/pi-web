"use client";

import { useMemo } from "react";
import { MessageView } from "./MessageView";
import { TodoPanel } from "./TodoPanel";
import { useI18n } from "@/hooks/useI18n";
import { formatRelativeTime } from "@/lib/i18n/format";
import type { SharedSessionSnapshot } from "@/lib/share-types";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";
import { deriveTodoState } from "@/lib/todo-state";

// The public, read-only rendering of a shared session. It reuses MessageView
// with only its passive props: no streaming, no callbacks, no session id (the
// snapshot's media is inline base64, never lazy /api/files URLs).

function buildToolResults(messages: AgentMessage[]): Map<string, ToolResultMessage> {
  const map = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === "toolResult") map.set(message.toolCallId, message);
  }
  return map;
}

export function SharedSessionView({ snapshot }: { snapshot: SharedSessionSnapshot }) {
  const { t, locale } = useI18n();
  const toolResults = useMemo(() => buildToolResults(snapshot.messages), [snapshot.messages]);
  const todoSnapshot = useMemo(() => deriveTodoState(snapshot.messages), [snapshot.messages]);

  const created = (() => {
    const ms = Date.parse(snapshot.createdAt);
    return Number.isFinite(ms) ? formatRelativeTime(new Date(ms), locale) : null;
  })();

  return (
    <div className="shared-session">
      <header className="shared-session-header">
        <h1>{snapshot.title}</h1>
        <div className="shared-session-meta">
          {created && <span>{t("sharePage.created", { time: created })}</span>}
          {snapshot.model && <span>{`${snapshot.model.provider}/${snapshot.model.modelId}`}</span>}
          <span>{t("sharePage.messageCount", { count: String(snapshot.messages.length) })}</span>
          {snapshot.cwd && <span className="shared-session-cwd">{snapshot.cwd}</span>}
        </div>
      </header>
      <TodoPanel snapshot={todoSnapshot} />
      <main className="shared-session-messages">
        {snapshot.messages.map((message, idx) => (
          <MessageView
            key={snapshot.entryIds[idx] ?? idx}
            message={message}
            toolResults={toolResults}
            showTimestamp
            prevTimestamp={idx > 0 ? (snapshot.messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
            cwd={snapshot.cwd}
          />
        ))}
      </main>
      <footer className="shared-session-footer">
        <span>{t("sharePage.footer")}</span>
      </footer>
    </div>
  );
}
