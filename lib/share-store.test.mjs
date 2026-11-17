import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
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
  renewShare,
  removeShare,
  removeShares,
  summarizeShare,
  isShareExpired,
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

const CODE = "abcdefghijklmnopqrstuv"; // 22 chars, on-pattern

function writeSharesFile(path, shares) {
  writeFileSync(path, JSON.stringify({ version: 1, shares }), { mode: 0o600 });
}

test("a file from before expiry support reads unchanged and counts as permanent", () => {
  const dir = tempDir();
  const path = join(dir, "pi-web-shares.json");
  try {
    writeSharesFile(path, {
      s1: { code: CODE, createdAt: "2026-01-01T00:00:00.000Z", snapshot: { messages: [] } },
    });
    const share = readShares(path).shares.s1;
    assert.ok(share);
    // The old shape is preserved as-is: no field is invented on read.
    assert.equal("expiresAt" in share, false);
    assert.equal("durationDays" in share, false);
    assert.equal(isShareExpired(share), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit nulls are permanent and legal: the file this code writes reads back", () => {
  const dir = tempDir();
  const path = join(dir, "pi-web-shares.json");
  try {
    writeSharesFile(path, {
      s1: {
        code: CODE,
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
        durationDays: null,
        snapshot: { messages: [] },
      },
    });
    const share = readShares(path).shares.s1;
    assert.ok(share);
    assert.equal(share.expiresAt, null);
    assert.equal(share.durationDays, null);
    assert.equal(isShareExpired(share), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bad expiresAt or durationDays values fail the whole file", () => {
  const dir = tempDir();
  const path = join(dir, "pi-web-shares.json");
  try {
    for (const extra of [
      { expiresAt: 42 },
      { expiresAt: "not-a-date" },
      { durationDays: 8 },
      { durationDays: "7" },
    ]) {
      writeSharesFile(path, {
        s1: { code: CODE, createdAt: "2026-01-01T00:00:00.000Z", ...extra, snapshot: { messages: [] } },
      });
      assert.deepEqual(readShares(path), { version: 1, shares: {} }, JSON.stringify(extra));
      assert.ok(
        readdirSync(dir).some((name) => name.startsWith("pi-web-shares.json.corrupt-")),
        JSON.stringify(extra),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("putShare computes expiresAt from the injected clock, defaulting to 7 days", async () => {
  const dir = tempDir();
  const path = join(dir, "pi-web-shares.json");
  const NOW = new Date("2026-02-01T00:00:00.000Z");
  try {
    const timed = await putShare("s1", snapshot("Timed"), path, { durationDays: 7, now: NOW });
    assert.equal(timed.createdAt, "2026-02-01T00:00:00.000Z");
    assert.equal(timed.expiresAt, "2026-02-08T00:00:00.000Z");
    assert.equal(timed.durationDays, 7);

    const permanent = await putShare("s2", snapshot("Forever"), path, { durationDays: null, now: NOW });
    assert.equal(permanent.expiresAt, null);
    assert.equal(permanent.durationDays, null);

    const defaulted = await putShare("s3", snapshot("Default"), path, { now: NOW });
    assert.equal(defaulted.expiresAt, "2026-02-08T00:00:00.000Z");
    assert.equal(defaulted.durationDays, 7);

    // The stored file carries what the share objects said.
    assert.equal(getShare("s2", path)?.expiresAt, null);
    assert.equal(getShare("s3", path)?.durationDays, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshing rolls the expiry forward and keeps the code, but stamps a new createdAt", async () => {
  const dir = tempDir();
  const path = join(dir, "pi-web-shares.json");
  const T0 = new Date("2026-02-01T00:00:00.000Z");
  try {
    const first = await putShare("s1", snapshot("First"), path, { durationDays: 7, now: T0 });
    const threeDaysLater = new Date(T0.getTime() + 3 * 86_400_000);
    const refreshed = await putShare("s1", snapshot("Second"), path, { durationDays: 7, now: threeDaysLater });
    assert.equal(refreshed.code, first.code);
    assert.equal(refreshed.createdAt, threeDaysLater.toISOString());
    assert.equal(refreshed.expiresAt, "2026-02-11T00:00:00.000Z"); // T0 + 10 days
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renewShare moves only the expiry metadata; a session without a share renews nothing", async () => {
  const dir = tempDir();
  const path = join(dir, "pi-web-shares.json");
  const T0 = new Date("2026-02-01T00:00:00.000Z");
  const RENEWED_AT = new Date("2026-02-05T00:00:00.000Z");
  try {
    const created = await putShare("s1", snapshot("Frozen"), path, { durationDays: 7, now: T0 });
    const renewed = await renewShare("s1", 30, path, { now: RENEWED_AT });
    assert.ok(renewed);
    assert.equal(renewed.code, created.code);
    assert.equal(renewed.createdAt, created.createdAt); // the freeze moment stays
    assert.equal(renewed.snapshot.title, "Frozen");
    assert.equal(renewed.expiresAt, "2026-03-07T00:00:00.000Z"); // renewed + 30 days
    assert.equal(renewed.durationDays, 30);

    const forever = await renewShare("s1", null, path, { now: RENEWED_AT });
    assert.equal(forever?.expiresAt, null);
    assert.equal(forever?.durationDays, null);

    // No share to renew: null, and the file on disk is untouched.
    const before = readFileSync(path, "utf8");
    assert.equal(await renewShare("nobody", 7, path, { now: RENEWED_AT }), null);
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isShareExpired: due means expired, null or missing means permanent", () => {
  const now = new Date("2026-02-01T00:00:00.000Z");
  assert.equal(isShareExpired({ expiresAt: "2026-02-01T00:00:00.000Z" }, now), true);
  assert.equal(isShareExpired({ expiresAt: "2026-02-01T00:00:01.000Z" }, now), false);
  assert.equal(isShareExpired({ expiresAt: null }, now), false);
  assert.equal(isShareExpired({}, now), false);
});

test("removeShares revokes many ids in one pass, deduplicating, keeping the rest", async () => {
  const dir = tempDir();
  const path = join(dir, "pi-web-shares.json");
  try {
    await putShare("s1", snapshot("One"), path);
    await putShare("s2", snapshot("Two"), path);
    await putShare("s3", snapshot("Three"), path);

    const revoked = await removeShares(["s3", "s1", "s3"], path);
    assert.deepEqual(revoked, ["s3", "s1"]);
    assert.equal(getShare("s1", path), null);
    assert.equal(getShare("s3", path), null);
    assert.equal(getShare("s2", path)?.snapshot.title, "Two");

    // Nothing matched: no ids, and the file was not rewritten.
    const before = readFileSync(path, "utf8");
    assert.deepEqual(await removeShares(["nope", "nada"], path), []);
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeShare carries expiresAt in both states", async () => {
  const dir = tempDir();
  const path = join(dir, "pi-web-shares.json");
  const NOW = new Date("2026-02-01T00:00:00.000Z");
  try {
    const timed = await putShare("s1", snapshot("Timed"), path, { durationDays: 7, now: NOW });
    assert.deepEqual(summarizeShare(timed), {
      code: timed.code,
      createdAt: "2026-02-01T00:00:00.000Z",
      expiresAt: "2026-02-08T00:00:00.000Z",
      durationDays: 7,
      title: "Timed",
    });
    const permanent = await putShare("s2", snapshot("Forever"), path, { durationDays: null, now: NOW });
    assert.deepEqual(summarizeShare(permanent), {
      code: permanent.code,
      createdAt: "2026-02-01T00:00:00.000Z",
      expiresAt: null,
      durationDays: null,
      title: "Forever",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
