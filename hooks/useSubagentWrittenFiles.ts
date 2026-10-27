"use client";

import { useEffect, useState } from "react";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";
import {
  collectSubagentSources,
  fetchSubagentWrittenFiles,
} from "@/lib/subagent-written-files";
import type { WrittenFile } from "@/lib/turn-written-files";

/**
 * The files the subagents of the shown messages wrote, keyed by subagent
 * session id. Fetches are cached for a settled session's life (a settled
 * transcript is immutable), so a re-render or a second turn costs nothing;
 * a failure retries only after 30 s. Files arrive a moment after the turn
 * ends — the chips gain them on the state bump that follows.
 */
export function useSubagentWrittenFiles(
  messages: readonly AgentMessage[],
  toolResults: ReadonlyMap<string, ToolResultMessage>,
  cwd: string | undefined,
): ReadonlyMap<string, WrittenFile[]> {
  const [files, setFiles] = useState<ReadonlyMap<string, WrittenFile[]>>(() => new Map());

  useEffect(() => {
    const sources = collectSubagentSources(messages, toolResults);
    if (sources.length === 0) return;
    let cancelled = false;
    Promise.allSettled(
      sources.map(async (source) => ({
        sessionId: source.sessionId,
        entry: await fetchSubagentWrittenFiles(source.sessionId, source.cwd, cwd),
      })),
    ).then((outcomes) => {
      if (cancelled) return;
      setFiles((current) => {
        let next: Map<string, WrittenFile[]> | null = null;
        for (const outcome of outcomes) {
          if (outcome.status !== "fulfilled") continue;
          const { sessionId, entry } = outcome.value;
          if (!entry || current.get(sessionId)) continue;
          next ??= new Map(current);
          next.set(sessionId, entry.files);
        }
        return next ?? current;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [messages, toolResults, cwd]);

  return files;
}
