export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitFileStatus {
  filePath: string;
  status: GitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "U" | "C";
  indexStatus: string;
  worktreeStatus: string;
  /** A rename's or copy's source path, when Git reported one. Committing the
   *  entry needs both sides, or the old name's deletion stays behind. */
  originalPath?: string;
}

export interface GitStatusResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  files: GitFileStatus[];
  additions: number;
  deletions: number;
}

export interface GitFileDiffResponse {
  supported: boolean;
  status?: GitFileStatusKind;
  patch?: string;
}

/** POST /api/git/commit's request body. Paths are absolute, exactly as
 *  /api/git/status reported them (a renamed entry carries both sides). */
export interface GitCommitRequest {
  cwd: string;
  paths: string[];
  message: string;
  push: boolean;
}

export type GitCommitFailureKind =
  | "empty-message"
  | "no-files"
  | "no-repository"
  | "outside-repository"
  | "nothing-to-commit";

export interface GitCommitResponse {
  ok: boolean;
  /** Short hash of the new commit (set once the commit itself succeeded). */
  commit?: string;
  pushed?: boolean;
  /** Why a successful commit was not pushed: "no-upstream" or git's message. */
  pushError?: string;
  /** Machine-readable failure kind for i18n; "git-error" falls back to `error`. */
  kind?: GitCommitFailureKind | "git-error";
  error?: string;
}

/** Where a commit's decoration points: HEAD, a local/remote branch or a tag. */
export type GitGraphRefKind = "head" | "branch" | "tag" | "remote";

export interface GitGraphRef {
  name: string;
  kind: GitGraphRefKind;
}

/** One commit of the graph, newest first. Parents reference loaded commits
 *  only; a parent outside the loaded page is simply absent. */
export interface GitGraphCommit {
  hash: string;
  parents: string[];
  refs: GitGraphRef[];
  subject: string;
  authorName: string | null;
  authoredAtMs: number | null;
}

export interface GitGraphResponse {
  commits: GitGraphCommit[];
  hasMore: boolean;
}
