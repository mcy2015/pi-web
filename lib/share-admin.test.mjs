import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { listSharesForAdmin } = await jiti.import("./share-admin.ts");
const { putShare, removeShares } = await jiti.import("./share-store.ts");

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
  return mkdtempSync(join(tmpdir(), "pi-web-share-admin-"));
}

test("orphan, expiry and ordering: the id set and the clock drive the rows", () => {
  const dir = tempDir();
  const path = join(dir, "pi-web-shares.json");
  try {
    // sid1 keeps its session, sid2's is gone; sid3 is expired on paper,
    // sid4 permanent. Hand-written rows carry expiresAt shapes putShare
    // cannot produce (an already-past expiry, a bare null).
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        shares: {
          sid1: {
            code: "abcdefghijklmnopqrstuv",
            createdAt: "2026-02-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
            snapshot: { messages: [], title: "Live" },
          },
          sid2: {
            code: "bcdefghijklmnopqrstuvw",
            createdAt: "2026-02-03T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
            snapshot: { messages: [], title: "Orphan" },
          },
          sid3: {
            code: "cdefghijklmnopqrstuvwx",
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-02T00:00:00.000Z",
            snapshot: { messages: [], title: "Expired" },
          },
          sid4: {
            code: "defghijklmnopqrstuvwxy",
            createdAt: "2026-01-05T00:00:00.000Z",
            expiresAt: null,
            snapshot: { messages: [], title: "Permanent" },
          },
        },
      }),
      { mode: 0o600 },
    );

    const items = listSharesForAdmin(new Set(["sid1"]), path);
    assert.deepEqual(items.map((item) => item.sessionId), ["sid2", "sid1", "sid4", "sid3"]); // createdAt desc
    const byId = Object.fromEntries(items.map((item) => [item.sessionId, item]));
    assert.equal(byId.sid1.orphan, false);
    assert.equal(byId.sid1.expired, false);
    assert.equal(byId.sid2.orphan, true);
    assert.equal(byId.sid2.title, "Orphan");
    assert.equal(byId.sid3.expired, true);
    assert.equal(byId.sid4.expired, false);
    assert.equal(byId.sid4.expiresAt, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revoking every listed share empties the admin list", async () => {
  const dir = tempDir();
  const path = join(dir, "pi-web-shares.json");
  try {
    await putShare("sid1", snapshot("One"), path);
    await putShare("sid2", snapshot("Two"), path);
    assert.equal(listSharesForAdmin(new Set(["sid1", "sid2"]), path).length, 2);

    await removeShares(["sid1", "sid2"], path);
    assert.deepEqual(listSharesForAdmin(new Set(["sid1", "sid2"]), path), []);
    assert.equal(readFileSync(path, "utf8"), JSON.stringify({ version: 1, shares: {} }, null, 2) + "\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
