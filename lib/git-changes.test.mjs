import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./git-status.ts");
}

test("parses null-delimited Git status entries including renames", async () => {
  const { parseGitPorcelainV1 } = await loadSubject();
  const entries = parseGitPorcelainV1([
    " M components/App.tsx",
    "?? notes.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.deepEqual(entries, [
    {
      path: "components/App.tsx",
      indexStatus: " ",
      worktreeStatus: "M",
    },
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
    },
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      indexStatus: "R",
      worktreeStatus: " ",
    },
  ]);
});

test("classifies Git status for explorer badges", async () => {
  const { classifyGitStatus } = await loadSubject();
  const classify = (pair) => classifyGitStatus({
    path: "file.ts",
    indexStatus: pair[0],
    worktreeStatus: pair[1],
  });

  assert.deepEqual(classify(" M"), { status: "modified", code: "M" });
  assert.deepEqual(classify("??"), { status: "untracked", code: "U" });
  assert.deepEqual(classify("A "), { status: "added", code: "A" });
  assert.deepEqual(classify("R "), { status: "renamed", code: "R" });
  assert.deepEqual(classify("UU"), { status: "conflict", code: "C" });
  assert.deepEqual(classify(" D"), { status: "deleted", code: "D" });
});

test("parses numstat rows, including binary and rename rows", async () => {
  const { parseGitNumstat } = await loadSubject();
  const entries = parseGitNumstat("12\t3\tsrc/a.ts\n-\t-\timg.png\n1\t2\told.ts => new.ts\n0\t1\t{old => new}/c.ts\n", "/repo");
  assert.deepEqual(entries, [
    { path: "/repo/src/a.ts", additions: 12, deletions: 3, renamed: false },
    { path: "/repo/img.png", additions: 0, deletions: 0, renamed: false },
    { path: "/repo/old.ts => new.ts", additions: 1, deletions: 2, renamed: true },
    { path: "/repo/{old => new}/c.ts", additions: 0, deletions: 1, renamed: true },
  ]);
  assert.deepEqual(parseGitNumstat("garbage\n\n7\t2\tpath\twith\ttabs\n"), [
    { path: "path\twith\ttabs", additions: 7, deletions: 2, renamed: false },
  ]);
});
