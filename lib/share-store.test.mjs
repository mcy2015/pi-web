import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  getSharesPath,
  readShares,
  getShare,
  findShareByCode,
  putShare,
  removeShare,
  newShareCode,
  ShareStoreLockedError,
} = await jiti.import("./share-store.ts");

const snapshot = (title) => ({
  version: 1,
  title,
  createdAt: new Date().toISOString(),
  cwd: "/tmp/project",
  model: { provider: "p", modelId: "m" },
  messages: [{ role: "user", content: "hi" }],
  entryIds: ["e1"],
});

function tempDir() {
  return mkdtempSync(join(tmpdir(), "pi-web-shares-"));
}

test("a missing file reads as empty", () => {
  const dir = tempDir();
  try {
    const shares = readShares(join(dir, "pi-web-shares.json"));
    assert.deepEqual(shares, { version: 1, shares: {} });
    assert.equal(getShare("s1", join(dir, "pi-web-shares.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("put, find, refresh keeps the code, remove revokes", async () => {
  const dir = tempDir();
  const path = join(dir, "pi-web-shares.json");
  try {
    const share = await putShare("s1", snapshot("First"), path);
    assert.match(share.code, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(getShare("s1", path)?.snapshot.title, "First");
    assert.ok(findShareByCode(share.code, path)?.sessionId === "s1");

    // Refreshing replaces the snapshot but keeps the link stable.
    const refreshed = await putShare("s1", snapshot("Second"), path);
    assert.equal(refreshed.code, share.code);
    assert.equal(findShareByCode(share.code, path)?.share.snapshot.title, "Second");

    // A second session gets a distinct code.
    const other = await putShare("s2", snapshot("Other"), path);
    assert.notEqual(other.code, share.code);

    assert.equal(await removeShare("s1", path), true);
    assert.equal(getShare("s1", path), null);
    assert.equal(findShareByCode(share.code, path), null);
    // Removing again is fine, just reports false.
    assert.equal(await removeShare("s1", path), false);
    // The other session's share is untouched.
    assert.ok(findShareByCode(other.code, path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unparsable file is set aside and reads as empty", () => {
  const dir = tempDir();
  const path = join(dir, "pi-web-shares.json");
  try {
    writeFileSync(path, "{ not json", { mode: 0o600 });
    const shares = readShares(path);
    assert.deepEqual(shares, { version: 1, shares: {} });
    // A corrupt backup was created beside the file.
    assert.ok(
      readdirSync(dir).some((name) => name.startsWith("pi-web-shares.json.corrupt-")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file with an invalid share entry reads as empty (all-or-nothing)", () => {
  const dir = tempDir();
  const path = join(dir, "pi-web-shares.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        shares: {
          s1: { code: "short", createdAt: "x", snapshot: { messages: [] } },
        },
      }),
      { mode: 0o600 },
    );
    assert.deepEqual(readShares(path), { version: 1, shares: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findShareByCode rejects off-pattern codes without reading shape", () => {
  const dir = tempDir();
  try {
    assert.equal(findShareByCode("../pi-web-shares.json", join(dir, "pi-web-shares.json")), null);
    assert.equal(findShareByCode("", join(dir, "pi-web-shares.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codes are 22-char base64url and unique-ish", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const code = newShareCode();
    assert.match(code, /^[A-Za-z0-9_-]{22}$/);
    seen.add(code);
  }
  assert.equal(seen.size, 50);
});

test("ShareStoreLockedError exists for the API to map", () => {
  assert.ok(new ShareStoreLockedError() instanceof Error);
});

test("getSharesPath lands inside the agent dir", () => {
  assert.match(getSharesPath("/agent"), /\/agent\/pi-web-shares\.json$/);
});
