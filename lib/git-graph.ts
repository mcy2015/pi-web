import { execFile } from "child_process";
import { promisify } from "util";
import type { GitGraphCommit, GitGraphRef, GitGraphResponse } from "./git-types";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const GIT_LOG_MAX_BUFFER = 8 * 1024 * 1024;

/** Commit records end with \x1e, fields inside a record are NUL-separated. */
const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x00";

export const GIT_GRAPH_DEFAULT_MAX_COUNT = 50;
export const GIT_GRAPH_MAX_COUNT_LIMIT = 200;

export function clampGraphMaxCount(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value < 1) return GIT_GRAPH_DEFAULT_MAX_COUNT;
  return Math.min(Math.floor(value), GIT_GRAPH_MAX_COUNT_LIMIT);
}

export function clampGraphSkip(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

async function git(cwd: string, args: string[], maxBuffer = GIT_LOG_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    // C locale keeps stderr matching stable regardless of the system language.
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"], 1024 * 1024)).trim() || null;
  } catch {
    return null;
  }
}

/** The stderr fragments an empty repository or a branchless HEAD produce for
 *  `git log HEAD`: they mean "no history to show", not a failure. */
const EMPTY_HISTORY_STDERR = [
  "does not have any commits yet",
  "your current branch",
  "bad default revision",
  "ambiguous argument 'head'",
];

function isEmptyHistoryError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return EMPTY_HISTORY_STDERR.some((fragment) => lower.includes(fragment));
}

function parseDecorationRef(token: string): GitGraphRef | null {
  const name = token.trim();
  if (!name) return null;
  if (name === "HEAD") return { name: "HEAD", kind: "head" };
  const tagPrefix = "tag: ";
  if (name.startsWith(tagPrefix)) {
    const tag = name.slice(tagPrefix.length).trim().replace(/^refs\/tags\//, "");
    return tag ? { name: tag, kind: "tag" } : null;
  }
  if (name.startsWith("refs/heads/")) {
    const branch = name.slice("refs/heads/".length);
    return branch ? { name: branch, kind: "branch" } : null;
  }
  if (name.startsWith("refs/remotes/")) {
    const remote = name.slice("refs/remotes/".length);
    return remote ? { name: remote, kind: "remote" } : null;
  }
  if (name.startsWith("refs/tags/")) {
    const tag = name.slice("refs/tags/".length);
    return tag ? { name: tag, kind: "tag" } : null;
  }
  // Short names from %D: a slash means a remote-tracking shorthand.
  return { name, kind: name.includes("/") ? "remote" : "branch" };
}

function parseRefs(decorations: string): GitGraphRef[] {
  const refs: GitGraphRef[] = [];
  for (const part of decorations.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const headPrefix = "HEAD -> ";
    if (token.startsWith(headPrefix)) {
      refs.push({ name: "HEAD", kind: "head" });
      const branch = parseDecorationRef(token.slice(headPrefix.length));
      if (branch) refs.push(branch);
      continue;
    }
    const ref = parseDecorationRef(token);
    if (ref) refs.push(ref);
  }
  return refs;
}

export function parseGitGraphLog(stdout: string): GitGraphCommit[] {
  const commits: GitGraphCommit[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [hash, parents, authorName, authoredAt, subject, decorations] = trimmed.split(FIELD_SEPARATOR);
    if (!hash) continue;
    const seconds = authoredAt ? Number.parseInt(authoredAt, 10) : Number.NaN;
    commits.push({
      hash,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      refs: parseRefs(decorations ?? ""),
      subject: subject ?? "",
      authorName: authorName || null,
      authoredAtMs: Number.isNaN(seconds) ? null : seconds * 1000,
    });
  }
  return commits;
}

/** One page of the commit graph, newest first. `maxCount + 1` is requested so
 *  the extra record answers hasMore without a second run. */
export async function getGitGraph(cwd: string, maxCount: number, skip: number): Promise<GitGraphResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) return { commits: [], hasMore: false };

  let stdout: string;
  try {
    stdout = await git(repositoryRoot, [
      "log", "HEAD", "--branches", "--tags", "--remotes",
      "--topo-order", "--date-order",
      `--skip=${skip}`,
      `--max-count=${maxCount + 1}`,
      `--format=%H%x00%P%x00%an%x00%at%x00%s%x00%D${RECORD_SEPARATOR}`,
    ]);
  } catch (error) {
    // An empty repository is an empty graph, not an error.
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && isEmptyHistoryError(stderr)) return { commits: [], hasMore: false };
    throw error;
  }
  const commits = parseGitGraphLog(stdout);
  return { commits: commits.slice(0, maxCount), hasMore: commits.length > maxCount };
}
