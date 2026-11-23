import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { isSdkUnsupportedError, isThinkingLevel, shadowingProjectKeys, writeDefaultPreferences, writeProjectDefaultPreferences } = await createJiti(import.meta.url)
  .import("./default-preferences.ts");

async function withSettings(run, { project } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-default-preferences-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  if (project) {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(project));
  }

  try {
    const settings = SettingsManager.create(cwd, agentDir);
    await run({ settings, cwd, agentDir, settingsPath: join(agentDir, "settings.json"), projectPath: join(cwd, ".pi", "settings.json") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("writes the saved default model without touching the thinking default", async () => {
  await withSettings(async ({ settings, settingsPath }) => {
    settings.setDefaultThinkingLevel("medium");
    await settings.flush();

    await writeDefaultPreferences(settings, { model: { provider: "deepseek", modelId: "deepseek-chat" } });

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(saved.defaultProvider, "deepseek");
    assert.equal(saved.defaultModel, "deepseek-chat");
    assert.equal(saved.defaultThinkingLevel, "medium");
  });
});

test("writes the saved default thinking level without touching the model default", async () => {
  await withSettings(async ({ settings, settingsPath }) => {
    settings.setDefaultModelAndProvider("saved", "saved-model");
    await settings.flush();

    await writeDefaultPreferences(settings, { thinkingLevel: "high" });

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(saved.defaultProvider, "saved");
    assert.equal(saved.defaultModel, "saved-model");
    assert.equal(saved.defaultThinkingLevel, "high");
  });
});

test("refuses to write when the global settings file could not be loaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-default-preferences-"));
  try {
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "settings.json"), "{ not json");
    const settings = SettingsManager.create(root, agentDir);

    await assert.rejects(writeDefaultPreferences(settings, { thinkingLevel: "high" }));
    assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), "{ not json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports project keys that would hide the edited global default", async () => {
  await withSettings(async ({ settings }) => {
    assert.deepEqual(
      shadowingProjectKeys(settings, { model: { provider: "a", modelId: "b" }, thinkingLevel: "low" }),
      ["defaultModel", "defaultThinkingLevel"],
    );
    // A project value for a field this edit does not write is irrelevant.
    assert.deepEqual(shadowingProjectKeys(settings, { model: { provider: "a", modelId: "b" } }), ["defaultModel"]);
  }, { project: { defaultModel: "project-model", defaultThinkingLevel: "off" } });

  await withSettings(async ({ settings }) => {
    assert.deepEqual(shadowingProjectKeys(settings, { thinkingLevel: "low" }), []);
  }, { project: { defaultProvider: "p" } });
});

test("accepts only pi thinking levels", () => {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(isThinkingLevel(level), true);
  }
  assert.equal(isThinkingLevel("auto"), false);
  assert.equal(isThinkingLevel(undefined), false);
});

// The project write rests on `updateProjectSettings`, typed `private` in the
// SDK's declarations: pin the contract the local cast relies on, so an SDK
// upgrade that reshapes it fails here and not in production.
test("SettingsManager exposes updateProjectSettings(field, update) on its prototype", () => {
  const method = SettingsManager.prototype.updateProjectSettings;
  assert.equal(typeof method, "function");
  assert.equal(method.length, 2);
});

test("a project default model writes both keys and keeps unrelated ones", async () => {
  await withSettings(async ({ settings, projectPath }) => {
    await writeProjectDefaultPreferences(settings, { set: { model: { provider: "deepseek", modelId: "deepseek-chat" } } });

    const saved = JSON.parse(await readFile(projectPath, "utf8"));
    assert.equal(saved.defaultProvider, "deepseek");
    assert.equal(saved.defaultModel, "deepseek-chat");
    assert.equal(saved.theme, "dark", "an unrelated project key survives the write");
    assert.equal(saved.defaultThinkingLevel, undefined);
  }, { project: { theme: "dark" } });
});

test("a project thinking default writes its key without touching the model default", async () => {
  await withSettings(async ({ settings, projectPath }) => {
    await writeProjectDefaultPreferences(settings, { set: { model: { provider: "p", modelId: "m" } } });
    await writeProjectDefaultPreferences(settings, { set: { thinkingLevel: "high" } });

    const saved = JSON.parse(await readFile(projectPath, "utf8"));
    assert.deepEqual(
      { provider: saved.defaultProvider, model: saved.defaultModel, thinking: saved.defaultThinkingLevel },
      { provider: "p", model: "m", thinking: "high" },
    );
  });
});

test("clearing removes the keys physically and keeps what it does not name", async () => {
  await withSettings(async ({ settings, projectPath }) => {
    await writeProjectDefaultPreferences(settings, {
      set: { model: { provider: "p", modelId: "m" }, thinkingLevel: "low" },
    });

    await writeProjectDefaultPreferences(settings, { clear: ["model"] });
    const saved = JSON.parse(await readFile(projectPath, "utf8"));
    assert.equal("defaultProvider" in saved, false, "the key is gone, not null");
    assert.equal("defaultModel" in saved, false);
    assert.equal(saved.defaultThinkingLevel, "low", "a field this clear does not name survives");
    assert.equal(saved.theme, "dark", "so does an unrelated project key");
  }, { project: { theme: "dark" } });

  // With nothing else in the file, clearing the last default leaves `{`,` on disk.
  await withSettings(async ({ settings, projectPath }) => {
    await writeProjectDefaultPreferences(settings, {
      set: { model: { provider: "p", modelId: "m" }, thinkingLevel: "low" },
    });
    await writeProjectDefaultPreferences(settings, { clear: ["model", "thinkingLevel"] });
    assert.equal(await readFile(projectPath, "utf8"), "{}", "the file itself is kept, empty");
  });
});

test("refuses to write when the project settings file could not be loaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-default-preferences-"));
  try {
    const cwd = join(root, "cwd");
    const agentDir = join(root, "agent");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir);
    await writeFile(join(cwd, ".pi", "settings.json"), "{ not json");
    const settings = SettingsManager.create(cwd, agentDir);

    await assert.rejects(writeProjectDefaultPreferences(settings, { set: { thinkingLevel: "high" } }));
    assert.equal(await readFile(join(cwd, ".pi", "settings.json"), "utf8"), "{ not json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to write a project it does not trust", async () => {
  await withSettings(async ({ cwd, agentDir }) => {
    const untrusted = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    await assert.rejects(
      writeProjectDefaultPreferences(untrusted, { set: { model: { provider: "p", modelId: "m" } } }),
      /Project is not trusted/,
    );
  });
});

test("a settings manager without the project writer is refused as sdk-unsupported", async () => {
  const proto = SettingsManager.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "updateProjectSettings");
  assert.ok(original, "the method lives on the prototype, as the cast assumes");
  Object.defineProperty(proto, "updateProjectSettings", { value: undefined, configurable: true, writable: true });
  try {
    await withSettings(async ({ settings, projectPath }) => {
      await assert.rejects(
        writeProjectDefaultPreferences(settings, { set: { thinkingLevel: "low" } }),
        (error) => isSdkUnsupportedError(error) && error.reason === "sdk-unsupported",
      );
      await assert.rejects(
        writeProjectDefaultPreferences(settings, { clear: ["model"] }),
        isSdkUnsupportedError,
      );
      assert.equal(await readFile(projectPath, "utf8"), "{}", "nothing was written");
    }, { project: {} });
  } finally {
    Object.defineProperty(proto, "updateProjectSettings", original);
  }
});
