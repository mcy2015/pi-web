import { join } from "path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { displaySettingsPath } from "./enabled-models-runtime";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel);
}

/** What the model and reasoning selectors' "save as default" action writes. */
export interface DefaultPreferencesEdit {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

/**
 * Project settings keys that would hide this edit.
 *
 * `SettingsManager` only ever writes the global file, and a project
 * `.pi/settings.json` value wins over it, so writing a default the project
 * overrides would report success while new chats kept starting with the
 * project's choice. The route refuses instead and names the file.
 */
export function shadowingProjectKeys(
  settingsManager: SettingsManager,
  edit: DefaultPreferencesEdit,
): string[] {
  const project = settingsManager.getProjectSettings();
  const keys: string[] = [];
  if (edit.model) {
    if (project.defaultProvider !== undefined) keys.push("defaultProvider");
    if (project.defaultModel !== undefined) keys.push("defaultModel");
  }
  if (edit.thinkingLevel && project.defaultThinkingLevel !== undefined) keys.push("defaultThinkingLevel");
  return keys;
}

export function projectSettingsPath(cwd: string): string {
  return displaySettingsPath(join(cwd, ".pi", "settings.json"));
}

/**
 * Persist the global defaults new sessions start with, like the TUI's Ctrl+S
 * in `/model` and `/thinking`.
 *
 * `SettingsManager` skips the write when it could not load the settings file
 * and collects storage failures instead of throwing, so the queue is drained
 * here: a default that did not reach disk must not report success.
 */
export async function writeDefaultPreferences(
  settingsManager: SettingsManager,
  edit: DefaultPreferencesEdit,
): Promise<void> {
  const loadErrors = settingsManager.drainErrors();
  const globalLoadError = loadErrors.find((entry) => entry.scope === "global");
  if (globalLoadError) throw globalLoadError.error;
  if (edit.model) settingsManager.setDefaultModelAndProvider(edit.model.provider, edit.model.modelId);
  if (edit.thinkingLevel) settingsManager.setDefaultThinkingLevel(edit.thinkingLevel);
  await settingsManager.flush();
  const errors = settingsManager.drainErrors();
  if (errors.length > 0) throw errors[0].error;
}

/** What a project-scoped "save as default" writes and which saved defaults it removes. */
export interface ProjectDefaultPreferencesEdit {
  set?: DefaultPreferencesEdit;
  clear?: ("model" | "thinkingLevel")[];
}

const SDK_UNSUPPORTED_BRAND: unique symbol = Symbol.for("pi-web:default-preferences-sdk-unsupported");

/**
 * The installed pi SDK cannot write project settings: the one method that
 * does is missing from `SettingsManager`'s prototype. A write would silently
 * do nothing, so it is refused with this instead.
 */
export class SdkUnsupportedError extends Error {
  readonly [SDK_UNSUPPORTED_BRAND] = true;
  readonly reason = "sdk-unsupported";

  constructor(message: string) {
    super(message);
    this.name = "SdkUnsupportedError";
  }
}

/** Tells the capability error by its brand, so a second copy of this module (hot reload, a test loader) still counts. */
export function isSdkUnsupportedError(error: unknown): error is SdkUnsupportedError {
  return typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[SDK_UNSUPPORTED_BRAND] === true;
}

/**
 * `SettingsManager.updateProjectSettings(field, update)`: clone the project
 * settings, let `update` mutate the clone, mark the field modified, persist.
 * It is the base of the SDK's five public `setProject*` methods
 * (`setProjectPackages`, `setProjectExtensionPaths`, …), typed `private` in
 * the declarations while present on the prototype at runtime, so it is
 * reached through a local cast guarded by a capability check.
 */
type ProjectSettingsUpdater = {
  updateProjectSettings(field: string, update: (settings: Record<string, unknown>) => void): void;
};

/**
 * Persist the defaults new sessions in this project start with, in
 * `<cwd>/.pi/settings.json`, or remove saved ones (`clear`).
 *
 * Like the global write, the queue is drained around it: the SDK skips the
 * project write when `.pi/settings.json` could not be loaded
 * (`saveProjectSettings` returns early on `projectSettingsLoadError`) and
 * collects storage failures instead of throwing, so a default that did not
 * reach disk must not report success. A `clear` works by assigning
 * `undefined`: `persistScopedSettings()` copies that into the merged file
 * content and `JSON.stringify` drops the key, removing it physically while
 * unrelated keys survive.
 */
export async function writeProjectDefaultPreferences(
  settingsManager: SettingsManager,
  edit: ProjectDefaultPreferencesEdit,
): Promise<void> {
  const loadErrors = settingsManager.drainErrors();
  const projectLoadError = loadErrors.find((entry) => entry.scope === "project");
  if (projectLoadError) throw projectLoadError.error;

  const writer = settingsManager as unknown as ProjectSettingsUpdater;
  if (typeof writer.updateProjectSettings !== "function") {
    throw new SdkUnsupportedError("This pi SDK version cannot write project settings");
  }

  const model = edit.set?.model;
  if (model) {
    writer.updateProjectSettings("defaultProvider", (settings) => {
      settings.defaultProvider = model.provider;
    });
    writer.updateProjectSettings("defaultModel", (settings) => {
      settings.defaultModel = model.modelId;
    });
  }
  const thinkingLevel = edit.set?.thinkingLevel;
  if (thinkingLevel) {
    writer.updateProjectSettings("defaultThinkingLevel", (settings) => {
      settings.defaultThinkingLevel = thinkingLevel;
    });
  }
  for (const field of edit.clear ?? []) {
    if (field === "model") {
      writer.updateProjectSettings("defaultProvider", (settings) => {
        settings.defaultProvider = undefined;
      });
      writer.updateProjectSettings("defaultModel", (settings) => {
        settings.defaultModel = undefined;
      });
    } else {
      writer.updateProjectSettings("defaultThinkingLevel", (settings) => {
        settings.defaultThinkingLevel = undefined;
      });
    }
  }
  await settingsManager.flush();
  const errors = settingsManager.drainErrors();
  if (errors.length > 0) throw errors[0].error;
}
