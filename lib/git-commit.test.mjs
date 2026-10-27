import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function loadSubject() {
  return import("./git-commit.ts");
}

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

test("normalizes commit messages", async () => {
  const { normalizeCommitMessage } = await loadSubject();

  assert.equal(normalizeCommitMessage("  Fix bug  "), "Fix bug");
  assert.equal(normalizeCommitMessage("Subject\n\nBody line"), "Subject\n\nBody line");
  assert.equal(normalizeCommitMessage("   "), null);
  assert.equal(normalizeCommitMessage(""), null);
});

test("resolves commit paths relative to the repository root", async () => {
  const { resolveCommitPaths } = await loadSubject();

  const root = "/tmp/repo";
  assert.deepEqual(
    resolveCommitPaths(root, ["/tmp/repo/lib/a.ts", "/tmp/repo/lib/b.ts"]),
    ["lib/a.ts", "lib/b.ts"],
  );
  // Duplicates collapse; the root itself is dropped.
  assert.deepEqual(resolveCommitPaths(root, ["/tmp/repo/x", "/tmp/repo/x", "/tmp/repo"]), ["x"]);
  // Escapes are refused.
  assert.equal(resolveCommitPaths(root, ["/tmp/repo/../escape"]), null);
  assert.equal(resolveCommitPaths(root, ["/tmp/other/file"]), null);
  assert.equal(resolveCommitPaths(root, [""]), null);
});

/** A fresh repository in a temp folder, with a bare clone standing in for the
 *  push remote (offline), and `t.after` cleaning everything up. */
async function setupRepository(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-git-commit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const work = path.join(dir, "work");
  const remote = path.join(dir, "remote.git");
  fs.mkdirSync(work, { recursive: true });
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main", work], { stdio: "pipe" });
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "Test");

  const { commitGitFiles } = await loadSubject();
  return { work, remote, commitGitFiles };
}

test("commits selected files and leaves other staged changes behind", async (t) => {
  const { work, commitGitFiles } = await setupRepository(t);
  const a = path.join(work, "a.txt");
  const b = path.join(work, "b.txt");
  fs.writeFileSync(a, "one\n");
  fs.writeFileSync(b, "one\n");
  git(work, "add", "a.txt", "b.txt");
  git(work, "commit", "-m", "initial");

  fs.writeFileSync(a, "two\n");
  fs.writeFileSync(b, "two\n");
  // Stage b too: committing only a must not sweep b in.
  git(work, "add", "b.txt");

  const result = await commitGitFiles({ cwd: work, paths: [a], message: "update a", push: false });
  assert.equal(result.ok, true);
  assert.match(result.commit, /^[0-9a-f]+$/);

  const log = execFileSync("git", ["-C", work, "log", "-1", "--name-only", "--pretty=format:"], { encoding: "utf8" });
  assert.equal(log.trim(), "a.txt");
  // b stays staged, uncommitted.
  const status = execFileSync("git", ["-C", work, "status", "--porcelain=v1"], { encoding: "utf8" });
  assert.equal(status.trim(), "M  b.txt");
});

test("commits untracked and deleted paths", async (t) => {
  const { work, commitGitFiles } = await setupRepository(t);
  const gone = path.join(work, "gone.txt");
  const fresh = path.join(work, "fresh.txt");
  fs.writeFileSync(gone, "x\n");
  git(work, "add", "gone.txt");
  git(work, "commit", "-m", "initial");

  fs.rmSync(gone);
  fs.writeFileSync(fresh, "new\n");

  const result = await commitGitFiles({ cwd: work, paths: [gone, fresh], message: "swap files", push: false });
  assert.equal(result.ok, true);
  const files = execFileSync("git", ["-C", work, "ls-files"], { encoding: "utf8" });
  assert.equal(files.trim(), "fresh.txt");
});

test("commits both sides of a rename", async (t) => {
  const { work, commitGitFiles } = await setupRepository(t);
  fs.writeFileSync(path.join(work, "old.ts"), "content\n");
  git(work, "add", "old.ts");
  git(work, "commit", "-m", "initial");
  git(work, "mv", "old.ts", "new.ts");

  const result = await commitGitFiles({
    cwd: work,
    paths: [path.join(work, "new.ts"), path.join(work, "old.ts")],
    message: "rename",
    push: false,
  });
  assert.equal(result.ok, true);
  const files = execFileSync("git", ["-C", work, "ls-files"], { encoding: "utf8" });
  assert.equal(files.trim(), "new.ts");
});

test("pushes to the upstream and reports a missing upstream", async (t) => {
  const { work, remote, commitGitFiles } = await setupRepository(t);
  fs.writeFileSync(path.join(work, "file.txt"), "one\n");
  await commitGitFiles({ cwd: work, paths: [path.join(work, "file.txt")], message: "initial", push: false });

  // No upstream yet: the commit stands, the push is reported as failed.
  fs.writeFileSync(path.join(work, "file.txt"), "two\n");
  const noUpstream = await commitGitFiles({ cwd: work, paths: [path.join(work, "file.txt")], message: "two", push: true });
  assert.equal(noUpstream.ok, true);
  assert.equal(noUpstream.pushed, false);
  assert.equal(noUpstream.pushError, "no-upstream");

  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-u", "origin", "main");

  fs.writeFileSync(path.join(work, "file.txt"), "three\n");
  const pushed = await commitGitFiles({ cwd: work, paths: [path.join(work, "file.txt")], message: "three", push: true });
  assert.equal(pushed.ok, true);
  assert.equal(pushed.pushed, true);
  assert.equal(pushed.pushError, undefined);

  const remoteHead = execFileSync("git", ["--git-dir", remote, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const localHead = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(remoteHead, localHead);
});

test("refuses bad requests without touching the repository", async (t) => {
  const { work, commitGitFiles } = await setupRepository(t);

  const empty = await commitGitFiles({ cwd: work, paths: [path.join(work, "a.txt")], message: "   ", push: false });
  assert.deepEqual(empty, { ok: false, kind: "empty-message", error: "Commit message is empty" });

  const none = await commitGitFiles({ cwd: work, paths: [], message: "msg", push: false });
  assert.equal(none.ok, false);
  assert.equal(none.kind, "no-files");

  const outside = await commitGitFiles({ cwd: work, paths: ["/tmp/definitely-outside.txt"], message: "msg", push: false });
  assert.equal(outside.ok, false);
  assert.equal(outside.kind, "outside-repository");

  const notRepo = await commitGitFiles({ cwd: os.tmpdir(), paths: ["/tmp/x"], message: "msg", push: false });
  assert.equal(notRepo.ok, false);
  assert.equal(notRepo.kind, "no-repository");
});

test("answers nothing-to-commit for a clean path", async (t) => {
  const { work, commitGitFiles } = await setupRepository(t);
  const file = path.join(work, "clean.txt");
  fs.writeFileSync(file, "stable\n");
  await commitGitFiles({ cwd: work, paths: [file], message: "initial", push: false });

  const again = await commitGitFiles({ cwd: work, paths: [file], message: "again", push: false });
  assert.equal(again.ok, false);
  assert.equal(again.kind, "nothing-to-commit");
});
