import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// PUT /api/models/default writes the user's settings files and trust.json, so
// every case runs against a PI_CODING_AGENT_DIR in a temporary folder, never
// the real ~/.pi/agent.
const root = realpathSync(await mkdtemp(join(tmpdir(), "pi-web-models-default-route-")));
const agentDir = join(root, "agent");
const trusted = join(root, "trusted");
const untrusted = join(root, "untrusted");
const fresh = join(root, "fresh");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousOffline = process.env.PI_OFFLINE;
const preservedEnv = {};
for (const key of ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
  if (key in process.env) {
    preservedEnv[key] = process.env[key];
    delete process.env[key];
  }
}
process.env.PI_CODING_AGENT_DIR = agentDir;
// The list is served from the SDK's own data and the models.json below, so the
// route never reaches for the network here.
process.env.PI_OFFLINE = "1";

await mkdir(agentDir, { recursive: true });
await writeFile(join(agentDir, "models.json"), JSON.stringify({
  providers: {
    acme: {
      name: "Acme Gateway",
      baseUrl: "https://example.invalid/v1",
      apiKey: "sk-test",
      api: "openai-completions",
      models: [{ id: "one", name: "Acme One" }],
    },
  },
}, null, 2));

// Only the folders themselves, never `root`: an allowed ancestor would make
// trusting one of them "trust too much" (freshFolderTrustBreadth).
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
delete globalThis.__piWebProviderModelCatalog;
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
const { PUT } = await jiti.import("./route.ts");
for (const folder of [trusted, untrusted, fresh]) allowFileRoot(folder);

after(async () => {
  for (const [key, val] of Object.entries(preservedEnv)) {
    process.env[key] = val;
  }
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
  await rm(root, { recursive: true, force: true });
});

const globalPath = join(agentDir, "settings.json");
const trustPath = join(agentDir, "trust.json");
const projectPath = (cwd) => join(cwd, ".pi", "settings.json");
const store = new ProjectTrustStore(agentDir);

beforeEach(async () => {
  await rm(globalPath, { force: true });
  await rm(trustPath, { force: true });
  for (const folder of [trusted, untrusted, fresh]) await rm(folder, { recursive: true, force: true });
  await mkdir(join(trusted, ".pi"), { recursive: true });
  await writeFile(projectPath(trusted), JSON.stringify({ theme: "dark" }, null, 2));
  await mkdir(join(untrusted, ".pi"), { recursive: true });
  await writeFile(projectPath(untrusted), JSON.stringify({ defaultModel: "untrusted-model" }, null, 2));
  await mkdir(fresh, { recursive: true });
});

async function put(body) {
  const response = await PUT(new Request("http://localhost/api/models/default", {
    method: "PUT",
    headers: { host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

const saveModel = (extra) => put({ provider: "acme", modelId: "one", ...extra });
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const trustFile = async () => (existsSync(trustPath) ? readJson(trustPath) : {});

test("a save without scope stays a global save, answered as before", async () => {
  const { status, body } = await saveModel({ cwd: trusted });
  assert.equal(status, 200);
  // The old response shape, down to the keys: no scope, no settingsPath.
  assert.deepEqual(body, { ok: true, defaultModel: { provider: "acme", modelId: "one" } });

  const saved = await readJson(globalPath);
  assert.equal(saved.defaultProvider, "acme");
  assert.equal(saved.defaultModel, "one");
  assert.deepEqual(await readJson(projectPath(trusted)), { theme: "dark" }, "the project file is untouched");
});

test("a global save into a project that overrides it is refused with the project way out", async () => {
  store.set(trusted, true);
  await writeFile(projectPath(trusted), JSON.stringify({ theme: "dark", defaultModel: "project-model" }, null, 2));
  const { status, body } = await saveModel({ cwd: trusted });
  assert.equal(status, 409);
  assert.equal(body.reason, "project-scope");
  assert.ok(body.error.endsWith("Save it as this project's default instead."), "the error points at the project save");
  assert.deepEqual(body.keys, ["defaultModel"]);
  assert.equal(await readFile(globalPath, "utf8").catch(() => ""), "", "nothing was written globally");
});

test("a project save writes the project file, once the folder is trusted", async () => {
  store.set(trusted, true);
  const { status, body } = await saveModel({ cwd: trusted, scope: "project" });
  assert.equal(status, 200);
  assert.deepEqual(body, {
    ok: true,
    scope: "project",
    defaultModel: { provider: "acme", modelId: "one" },
    settingsPath: projectPath(trusted),
  });

  const saved = await readJson(projectPath(trusted));
  assert.deepEqual(
    { provider: saved.defaultProvider, model: saved.defaultModel, theme: saved.theme },
    { provider: "acme", model: "one", theme: "dark" },
    "both keys written, the unrelated one preserved",
  );
  assert.equal(await readFile(globalPath, "utf8").catch(() => ""), "", "the global file is untouched");

  // Only a model the selector can offer is a default that takes effect.
  const missing = await put({ cwd: trusted, scope: "project", provider: "acme", modelId: "nope" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "Model not available: acme/nope");
});

test("a project save can clear saved defaults, and only as a project save", async () => {
  store.set(trusted, true);
  await writeFile(projectPath(trusted), JSON.stringify({
    theme: "dark",
    defaultProvider: "acme",
    defaultModel: "one",
    defaultThinkingLevel: "low",
  }, null, 2));

  const { status, body } = await put({ cwd: trusted, scope: "project", clear: ["model"] });
  assert.equal(status, 200);
  assert.deepEqual(body, {
    ok: true,
    scope: "project",
    cleared: ["model"],
    settingsPath: projectPath(trusted),
  });

  const saved = await readJson(projectPath(trusted));
  assert.equal("defaultProvider" in saved, false);
  assert.equal("defaultModel" in saved, false);
  assert.equal(saved.defaultThinkingLevel, "low", "a field the clear does not name survives");

  assert.equal((await put({ cwd: trusted, clear: ["model"] })).status, 400, "clear without a project scope");
  assert.equal(
    (await put({ cwd: trusted, scope: "project", provider: "acme", modelId: "one", clear: ["model"] })).status,
    400,
    "a field cannot be set and cleared at once",
  );
  assert.equal(
    (await put({ cwd: trusted, scope: "project", clear: ["model", "bogus"] })).status,
    400,
    "clear accepts only its two fields",
  );
});

test("an untrusted project is refused, its settings file untouched", async () => {
  const before = await readFile(projectPath(untrusted), "utf8");
  const { status, body } = await saveModel({ cwd: untrusted, scope: "project" });
  assert.equal(status, 403);
  assert.equal(body.reason, "project-untrusted");
  assert.equal(body.settingsPath, projectPath(untrusted));
  assert.match(body.error, /Restricted banner/);
  assert.equal(await readFile(projectPath(untrusted), "utf8"), before, "the project file is untouched");
  assert.deepEqual(await trustFile(), {}, "no decision was written");
});

test("a fresh folder is trusted and written in one step, only when asked to", async () => {
  const { status, body } = await saveModel({ cwd: fresh, scope: "project", trustFolder: true });
  assert.equal(status, 200);
  assert.equal(body.scope, "project");
  assert.deepEqual(await trustFile(), { [fresh]: true }, "the trust decision landed");
  const saved = await readJson(projectPath(fresh));
  assert.deepEqual({ provider: saved.defaultProvider, model: saved.defaultModel }, { provider: "acme", model: "one" });
});

test("a folder with an explicit refusal is not trusted, even when asked to", async () => {
  store.set(fresh, false);
  const { status, body } = await saveModel({ cwd: fresh, scope: "project", trustFolder: true });
  assert.equal(status, 403);
  assert.equal(body.reason, "project-untrusted");
  assert.equal(body.trust.decision, false);
  assert.equal(existsSync(projectPath(fresh)), false, "nothing was written");
  assert.deepEqual(await trustFile(), { [fresh]: false }, "the refusal stands");
});

test("a fresh folder without the step is told what it needs first", async () => {
  const { status, body } = await saveModel({ cwd: fresh, scope: "project" });
  assert.equal(status, 409);
  assert.equal(body.reason, "trust-required");
  assert.equal(body.settingsPath, projectPath(fresh));
  assert.equal(existsSync(join(fresh, ".pi")), false, "the folder is left alone");
  assert.deepEqual(await trustFile(), {}, "no decision was written");
});

test("a global save is no longer refused by an untrusted project's file", async () => {
  // The folder's .pi/settings.json sets a default, but no decision trusts it,
  // so sessions ignore it and the global save must go through.
  const { status, body } = await saveModel({ cwd: untrusted });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, defaultModel: { provider: "acme", modelId: "one" } });
  const saved = await readJson(globalPath);
  assert.equal(saved.defaultModel, "one");
  assert.deepEqual(await readJson(projectPath(untrusted)), { defaultModel: "untrusted-model" });
});
