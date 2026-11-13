"use client";

import { MarkdownBody } from "./MarkdownBody";
import { useI18n } from "@/hooks/useI18n";
import { formatCompactCount, formatCostShort } from "@/lib/session-stats-format";
import type { BtwNote } from "@/lib/btw-note";

/** A saved pi-btw side question & answer, as the extension writes it with `--save`. */
export function BtwNoteCard({ note, cwd, onOpenFile }: {
  note: BtwNote;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
}) {
  const { t } = useI18n();
  const stats: string[] = [];
  const totalTokens = note.usage?.totalTokens;
  if (totalTokens !== undefined && totalTokens > 0) stats.push(formatCompactCount(totalTokens));
  const cost = formatCostShort(note.usage?.cost?.total ?? 0);
  if (cost) stats.push(cost);

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650, flexShrink: 0 }}>
            btw
          </span>
          {(note.provider || note.model) && (
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {[note.provider, note.model].filter(Boolean).join("/")}
            </span>
          )}
          {stats.length > 0 && (
            <span style={{ marginLeft: "auto", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
              {stats.join(" · ")}
            </span>
          )}
        </div>

        <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
          {note.question !== "" && (
            <div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 3 }}>{t("btw.question")}</div>
              <div
                style={{
                  color: "var(--text-muted)",
                  fontSize: "calc(13px + var(--chat-font-size-offset, 0px))",
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {note.question}
              </div>
            </div>
          )}
          {note.answer !== "" && (
            <div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 3 }}>{t("btw.answer")}</div>
              <MarkdownBody cwd={cwd} onOpenFile={onOpenFile}>{note.answer}</MarkdownBody>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
