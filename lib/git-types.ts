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
