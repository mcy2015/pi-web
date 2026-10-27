"use client";

import { useEffect, useState } from "react";
import type { GitStatusResponse } from "@/lib/git-types";

export interface GitFileStat {
  additions: number;
  deletions: number;
}

const CACHE_TTL_MS = 10_000;

interface CacheSlot {
  at: number;
  value: Map<string, GitFileStat> | null;
}

/** One shared fetch per cwd and TTL window, however many chips are mounted. */
const cache = new Map<string, CacheSlot>();
const inflight = new Map<string, Promise<Map<string, GitFileStat> | null>>();

async function loadFileStats(cwd: string): Promise<Map<string, GitFileStat> | null> {
  const now = Date.now();
  const cached = cache.get(cwd);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;
  const pending = inflight.get(cwd);
  if (pending) return pending;

  const load = (async () => {
    try {
      const res = await fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json() as GitStatusResponse;
      const stats = new Map<string, GitFileStat>();
      if (data.isGitRepository) {
        for (const file of data.files) {
          if (file.additions === undefined && file.deletions === undefined) continue;
          stats.set(file.filePath, { additions: file.additions ?? 0, deletions: file.deletions ?? 0 });
        }
      }
      return stats;
    } catch {
      return null;
    } finally {
      inflight.delete(cwd);
    }
  })();

  inflight.set(cwd, load);
  const value = await load;
  cache.set(cwd, { at: Date.now(), value });
  return value;
}

/** Seed the cache (tests): a cwd's stats without a fetch. */
export function setGitFileStatsForTests(cwd: string, stats: Map<string, GitFileStat> | null, ageMs = 0): void {
  cache.set(cwd, { at: Date.now() - ageMs, value: stats });
}

function readCachedStats(cwd: string): Map<string, GitFileStat> | null | undefined {
  const cached = cache.get(cwd);
  return cached && Date.now() - cached.at < CACHE_TTL_MS ? cached.value : undefined;
}

/**
 * Per-file `+n −m` line counts of a cwd's working tree, for the chips a turn's
 * written files show. Undefined while the first load is under way; null when
 * the cwd is not a git repository (or the fetch failed) and no badge shows.
 */
export function useGitFileStats(cwd: string | undefined): Map<string, GitFileStat> | null | undefined {
  // A fresh cache entry seeds the state synchronously, so a remounted chip
  // paints its badge at once instead of one fetch-and-rerender later.
  const [stats, setStats] = useState<Map<string, GitFileStat> | null | undefined>(() =>
    cwd ? readCachedStats(cwd) : undefined,
  );

  useEffect(() => {
    if (!cwd) {
      setStats(undefined);
      return;
    }
    const cached = readCachedStats(cwd);
    if (cached !== undefined) {
      setStats(cached);
      return;
    }
    setStats(undefined);
    let cancelled = false;
    loadFileStats(cwd).then((value) => {
      if (!cancelled) setStats(value);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  return stats;
}
