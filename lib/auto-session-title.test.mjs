import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { autoNameSessionAfterRun } = await jiti.import("./auto-session-title.ts");

/** A session stub: only the name matters, plus what the naming writes back. */
function sessionStub(initialName) {
  const stub = {
    name: initialName,
    sessionManager: {},
  };
  stub.sessionManager.getSessionName = () => stub.name;
  stub.setSessionName = (title) => {
    if (stub.name !== undefined) throw new Error("setSessionName overwrote an existing name");
    stub.name = title;
  };
  return stub;
}

test("names an unnamed session after a completed answer", async () => {
  const session = sessionStub(undefined);
  const title = await autoNameSessionAfterRun(session, {
    readEnabled: () => true,
    generate: async () => ({ title: "修复 SSE 重连" }),
  });
  assert.equal(title, "修复 SSE 重连");
  assert.equal(session.sessionManager.getSessionName(), "修复 SSE 重连");
});

test("does nothing when the setting is off", async () => {
  const session = sessionStub(undefined);
  let generated = 0;
  const title = await autoNameSessionAfterRun(session, {
    readEnabled: () => false,
    generate: async () => {
      generated += 1;
      return { title: "never" };
    },
  });
  assert.equal(title, null);
  assert.equal(generated, 0);
  assert.equal(session.sessionManager.getSessionName(), undefined);
});

test("never renames an already named session", async () => {
  const session = sessionStub("用户起的名字");
  let generated = 0;
  const title = await autoNameSessionAfterRun(session, {
    readEnabled: () => true,
    generate: async () => {
      generated += 1;
      return { title: "模型的标题" };
    },
  });
  assert.equal(title, null);
  assert.equal(generated, 0);
  assert.equal(session.sessionManager.getSessionName(), "用户起的名字");
});

test("a rename landing while the title generates wins", async () => {
  const session = sessionStub(undefined);
  const title = await autoNameSessionAfterRun(session, {
    readEnabled: () => true,
    generate: async () => {
      session.name = "抢先生成的名字";
      return { title: "迟到的标题" };
    },
  });
  assert.equal(title, null);
  assert.equal(session.sessionManager.getSessionName(), "抢先生成的名字");
});

test("a session disposed while its title generated is left alone", async () => {
  const session = sessionStub(undefined);
  const title = await autoNameSessionAfterRun(session, {
    readEnabled: () => true,
    generate: async () => ({ title: "迟到的标题" }),
    isAlive: () => false,
  });
  assert.equal(title, null);
  assert.equal(session.sessionManager.getSessionName(), undefined);
});
