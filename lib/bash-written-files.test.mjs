import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { extractBashWrittenPaths } = await jiti.import("./bash-written-files.ts");

test("redirects: >, >>, &>, attached and fd-numbered forms", () => {
  assert.deepEqual(extractBashWrittenPaths("echo hi > out.txt"), ["out.txt"]);
  assert.deepEqual(extractBashWrittenPaths("echo hi >> out.txt"), ["out.txt"]);
  assert.deepEqual(extractBashWrittenPaths("cmd &>log.txt"), ["log.txt"]);
  assert.deepEqual(extractBashWrittenPaths("cmd &>>log.txt"), ["log.txt"]);
  assert.deepEqual(extractBashWrittenPaths("cmd 2>err.log 1>out.log"), ["err.log", "out.log"]);
  assert.deepEqual(extractBashWrittenPaths("cmd 2>>err.log"), ["err.log"]);
  assert.deepEqual(extractBashWrittenPaths("ls > '/tmp/a b.txt'"), ["/tmp/a b.txt"]);
});

test("redirects: /dev/null, fd duplication and heredocs write nothing", () => {
  assert.deepEqual(extractBashWrittenPaths("cmd 2>/dev/null"), []);
  assert.deepEqual(extractBashWrittenPaths("cmd 2>&1"), []);
  assert.deepEqual(extractBashWrittenPaths("cat <<EOF\nhello\nEOF"), []);
  assert.deepEqual(extractBashWrittenPaths("cat <<'EOF'"), []);
});

test("tee lists its file operand", () => {
  assert.deepEqual(extractBashWrittenPaths("echo x | tee -a log.txt"), ["log.txt"]);
  assert.deepEqual(extractBashWrittenPaths("cmd | tee out1.txt out2.txt"), ["out1.txt", "out2.txt"]);
  assert.deepEqual(extractBashWrittenPaths("cmd | tee"), []);
});

test("touch lists its operands but not option values", () => {
  assert.deepEqual(extractBashWrittenPaths("touch a.txt b.txt"), ["a.txt", "b.txt"]);
  assert.deepEqual(extractBashWrittenPaths("touch -c -d '2020-01-01' stamp.txt"), ["stamp.txt"]);
});

test("mv and cp list their destination, expanding -t and trailing-slash dirs", () => {
  assert.deepEqual(extractBashWrittenPaths("mv old.ts new.ts"), ["new.ts"]);
  assert.deepEqual(extractBashWrittenPaths("cp -r src dst"), ["dst"]);
  assert.deepEqual(extractBashWrittenPaths("mv -t lib a.ts b.ts"), ["lib/a.ts", "lib/b.ts"]);
  assert.deepEqual(extractBashWrittenPaths("mv a.ts lib/"), ["lib/a.ts"]);
  assert.deepEqual(extractBashWrittenPaths("mv --target-directory=out a.ts"), ["out/a.ts"]);
  assert.deepEqual(extractBashWrittenPaths("mv"), []);
});

test("sed writes only with -i, and only its file operands", () => {
  assert.deepEqual(extractBashWrittenPaths("sed -i 's/a/b/' file.ts"), ["file.ts"]);
  assert.deepEqual(extractBashWrittenPaths("sed -i -e 's/a/b/' -e 's/c/d/' one.ts two.ts"), ["one.ts", "two.ts"]);
  assert.deepEqual(extractBashWrittenPaths("sed -i.bak 's/a/b/' file.ts"), ["file.ts"]);
  assert.deepEqual(extractBashWrittenPaths("sed --in-place 's/a/b/' file.ts"), ["file.ts"]);
  assert.deepEqual(extractBashWrittenPaths("sed 's/a/b/' file.ts"), []);
});

test("truncate and dd of= are writes", () => {
  assert.deepEqual(extractBashWrittenPaths("truncate -s 0 big.log"), ["big.log"]);
  assert.deepEqual(extractBashWrittenPaths("dd if=img.iso of=/tmp/copy.iso"), ["/tmp/copy.iso"]);
});

test("chains and pipelines: every segment counts", () => {
  assert.deepEqual(
    extractBashWrittenPaths("cd lib && sed -i 's/x/y/' a.ts; echo done > log.txt"),
    ["a.ts", "log.txt"],
  );
  assert.deepEqual(extractBashWrittenPaths("echo x | tee one.log | wc > two.log"), ["one.log", "two.log"]);
});

test("prefixes sudo/env/assignments and full command paths", () => {
  assert.deepEqual(extractBashWrittenPaths("sudo tee /etc/hosts"), ["/etc/hosts"]);
  assert.deepEqual(extractBashWrittenPaths("FOO=1 /usr/bin/sed -i 's/a/b/' f.ts"), ["f.ts"]);
  assert.deepEqual(extractBashWrittenPaths("env LC_ALL=C sed -i 's/a/b/' f.ts"), ["f.ts"]);
});

test("opaque words are dropped: globs, variables, substitutions, comments", () => {
  assert.deepEqual(extractBashWrittenPaths("echo hi > $OUT"), []);
  assert.deepEqual(extractBashWrittenPaths("echo hi > $(mktemp)"), []);
  assert.deepEqual(extractBashWrittenPaths("echo hi > *.tmp"), []);
  assert.deepEqual(extractBashWrittenPaths("echo hi > ~/note.txt"), []);
  assert.deepEqual(extractBashWrittenPaths("echo hi > out.txt # trailing note"), ["out.txt"]);
});

test("quoted words keep their spaces and no cd target leaks", () => {
  assert.deepEqual(extractBashWrittenPaths('printf "%s" x > "My File.txt"'), ["My File.txt"]);
  assert.deepEqual(extractBashWrittenPaths("cd /tmp && ls > list.txt"), ["list.txt"]);
});

test("non-writing commands list nothing", () => {
  assert.deepEqual(extractBashWrittenPaths("ls -la"), []);
  assert.deepEqual(extractBashWrittenPaths("git status"), []);
  assert.deepEqual(extractBashWrittenPaths("rm -rf build"), []);
  assert.deepEqual(extractBashWrittenPaths(""), []);
});
