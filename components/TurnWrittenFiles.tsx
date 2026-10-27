"use client";

import { useI18n } from "@/hooks/useI18n";
import { useGitFileStats } from "@/hooks/useGitFileStats";
import { getFileName } from "@/lib/file-paths";
import type { WrittenFile } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";

/**
 * Lists the files a turn actually wrote, as buttons that open each one in the
 * preview pane. Entries come from the turn's successful `write`/`edit` tool
 * calls — the reply text is never scanned for paths. In a git repository each
 * chip carries the file's working-tree `+n −m` line counts while they are
 * uncommitted (a committed or reverted file simply shows none).
 */
export function TurnWrittenFiles({ files, onOpenFile, cwd }: {
  files: WrittenFile[];
  onOpenFile?: (filePath: string) => void;
  cwd?: string;
}) {
  const { t } = useI18n();
  const gitStats = useGitFileStats(files.length > 0 ? cwd : undefined);
  if (files.length === 0) return null;

  return (
    <div aria-label={t("chat.filesWritten")} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 6 }}>
      {files.map(({ filePath }) => {
        const name = getFileName(filePath);
        const stats = gitStats?.get(filePath);
        return (
          <button
            key={filePath}
            type="button"
            title={filePath}
            aria-label={t("chat.openWrittenFile", { name })}
            onClick={() => onOpenFile?.(filePath)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: "var(--text)",
              background: "var(--bg-subtle)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            {getFileIcon(name, 12)}
            <span>{name}</span>
            {stats && (stats.additions > 0 || stats.deletions > 0) && (
              <span aria-hidden="true" style={{ fontSize: 11, whiteSpace: "nowrap", color: "var(--text-dim)" }}>
                <span style={{ color: "#3fb950" }}>+{stats.additions}</span>{" "}
                <span style={{ color: "#f85149" }}>−{stats.deletions}</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
