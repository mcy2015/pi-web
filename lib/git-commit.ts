import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import type {
  GitCommitRequest,
  GitCommitResponse,
} from "./git-types";

const execFileAsync = promisify(execFile);
// Status and diffs stay quick; a push crosses the network, so it gets room.
const GIT_TIMEOUT_MS = 15_000;
const GIT_PUSH_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
export const COMMIT_MESSAGE_MAX_CHARS = 10_000;
export const COMMIT_PATHS_MAX = 1_000;

async function git(
  cwd: string,
  args: string[],
  timeout: number = GIT_TIMEOUT_MS,
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

function isWithinPath(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

/** The path as the filesystem really spells it, so a path built from a
 *  symlinked prefix (macOS /tmp, /var) still lands inside the repository root
 *  git reported. A deleted file falls back to its nearest existing ancestor
 *  with the missing tail re-attached; anything unreadable stays as given. */
function toRealPath(resolved: string): string {
  try {
    return fs.realpathSync(resolved);
  } catch {
    // Walked below.
  }
  let directory = path.dirname(resolved);
  let tail = path.basename(resolved);
  for (;;) {
    try {
      return path.join(fs.realpathSync(directory), tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return resolved;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return resolved;
    tail = path.join(path.basename(directory), tail);
    directory = parent;
  }
}

/** Trimmed commit message, or null when there is nothing usable. */
export function normalizeCommitMessage(raw: string): string | null {
  const message = raw.trim();
  if (!message) return null;
  return message.length > COMMIT_MESSAGE_MAX_CHARS ? null : message;
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

/** Repo-relative POSIX paths for the request's absolute ones, deduplicated.
 *  A path outside the repository (or empty) answers null: refused. */
export function resolveCommitPaths(repositoryRoot: string, filePaths: readonly string[]): string[] | null {
  const seen = new Set<string>();
  for (const filePath of filePaths) {
    if (!filePath) return null;
    const resolved = path.resolve(filePath);
    if (!isWithinPath(repositoryRoot, resolved)) return null;
    const gitPath = toGitPath(path.relative(repositoryRoot, resolved));
    if (!gitPath || gitPath === "." || seen.has(gitPath)) continue;
    seen.add(gitPath);
  }
  return [...seen];
}

async function readShortHead(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

function gitErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = (error as { stderr?: string }).stderr;
    if (typeof stderr === "string" && stderr.trim()) {
      return stderr.trim().split(/\r?\n/).slice(0, 5).join("\n");
    }
    const message = (error as Error).message;
    if (message) return message;
  }
  return String(error);
}

/** Everything git printed for a failed command. "Nothing to commit" and
 *  similar advice land on stdout, not stderr, so both are checked. */
function commandOutput(error: unknown): string {
  if (error && typeof error === "object") {
    return `${String((error as { stderr?: string }).stderr ?? "")}\n${String((error as { stdout?: string }).stdout ?? "")}`;
  }
  return "";
}

function isNothingToCommit(error: unknown): boolean {
  return /nothing to commit|no changes added|nothing added to commit/i.test(commandOutput(error));
}

/** Commit the selected paths and, when asked, push the branch upstream.
 *  The commit itself is never forceful and never touches other staged files;
 *  a plain `git push` follows — rejected or missing upstream comes back as
 *  pushError on an otherwise successful commit. */
export async function commitGitFiles(request: GitCommitRequest): Promise<GitCommitResponse> {
  const message = normalizeCommitMessage(request.message);
  if (!message) {
    return { ok: false, kind: "empty-message", error: "Commit message is empty" };
  }
  const filePaths = request.paths;
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return { ok: false, kind: "no-files", error: "No files selected" };
  }
  if (filePaths.length > COMMIT_PATHS_MAX) {
    return { ok: false, kind: "no-files", error: `Too many paths (max ${COMMIT_PATHS_MAX})` };
  }

  const repositoryRoot = await findRepositoryRoot(request.cwd);
  if (!repositoryRoot) {
    return { ok: false, kind: "no-repository", error: "Not inside a Git repository" };
  }

  const commitPaths = resolveCommitPaths(
    toRealPath(repositoryRoot),
    filePaths.map((filePath) => toRealPath(path.resolve(filePath))),
  );
  if (!commitPaths || commitPaths.length === 0) {
    return { ok: false, kind: "outside-repository", error: "A path is outside the repository" };
  }

  try {
    // `git add` refuses a pathspec it cannot match: after a staged rename
    // (`git mv`) the old name is neither in the worktree nor in the index.
    // Such paths are left out of the add (their change is already staged)
    // but still named in the commit, which takes HEAD-known paths too.
    const trackedPaths = new Set(
      (await git(repositoryRoot, ["ls-files", "-z", "--", ...commitPaths])).split("\0").filter(Boolean),
    );
    const addablePaths = commitPaths.filter((gitPath) =>
      fs.existsSync(path.join(repositoryRoot, gitPath)) || trackedPaths.has(gitPath));
    if (addablePaths.length > 0) {
      // Staging covers untracked files; `git add` also stages deletions of
      // the named paths since git 2.0.
      await git(repositoryRoot, ["add", "--", ...addablePaths]);
    }
    // Committing with pathspecs keeps anything else already staged out of
    // this commit. A merge refuses partial commits: resolved conflicts were
    // staged above, so the merge is completed with the full index instead.
    try {
      await git(repositoryRoot, ["commit", "-m", message, "--", ...commitPaths]);
    } catch (error) {
      if (/cannot do a partial commit during a merge/i.test(commandOutput(error))) {
        await git(repositoryRoot, ["commit", "-m", message]);
      } else {
        throw error;
      }
    }
  } catch (error) {
    if (isNothingToCommit(error)) {
      return { ok: false, kind: "nothing-to-commit", error: "Nothing to commit" };
    }
    return { ok: false, kind: "git-error", error: gitErrorMessage(error) };
  }

  const commit = await readShortHead(repositoryRoot);
  if (!commit) {
    return { ok: false, kind: "git-error", error: "Commit finished but HEAD could not be read" };
  }

  let pushed = false;
  let pushError: string | undefined;
  if (request.push) {
    try {
      // A plain push only: never --force, never --set-upstream.
      await git(repositoryRoot, ["push"], GIT_PUSH_TIMEOUT_MS);
      pushed = true;
    } catch (error) {
      const output = commandOutput(error);
      pushError = /no configured push destination|no upstream|no configured upstream|does not have an upstream|has no upstream branch/i.test(output)
        ? "no-upstream"
        : gitErrorMessage(error);
    }
  }

  const response: GitCommitResponse = { ok: true, commit, pushed };
  if (pushError) response.pushError = pushError;
  return response;
}
