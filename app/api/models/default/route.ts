import { stat } from "fs/promises";
import { resolve } from "path";
import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  isSdkUnsupportedError,
  isThinkingLevel,
  projectSettingsPath,
  shadowingProjectKeys,
  writeDefaultPreferences,
  writeProjectDefaultPreferences,
  type DefaultPreferencesEdit,
} from "@/lib/default-preferences";
import { createEnabledModelsSettingsManager } from "@/lib/enabled-models-runtime";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { resolveVisibleModels } from "@/lib/model-scope";
import { withDeferredProviderModels } from "@/lib/deferred-provider-models";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getProjectTrustStatus, projectTrustReloadOptions, trustFreshFolderAndWrite } from "@/lib/project-trust";
import { llamaCppExtension } from "@/lib/pi-sdk-internals";

export const dynamic = "force-dynamic";

interface DefaultPreferencesRequest {
  cwd?: unknown;
  provider?: unknown;
  modelId?: unknown;
  thinkingLevel?: unknown;
  scope?: unknown;
  clear?: unknown;
  trustFolder?: unknown;
}

/** The fields a request removes from the project settings, deduplicated, first occurrence first. */
type ClearField = "model" | "thinkingLevel";

function parseClear(value: unknown): ClearField[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((entry) => entry === "model" || entry === "thinkingLevel")) return null;
  return [...new Set(value as ClearField[])];
}

function parseEdit(body: DefaultPreferencesRequest): DefaultPreferencesEdit | null {
  const edit: DefaultPreferencesEdit = {};
  if (body.provider !== undefined || body.modelId !== undefined) {
    if (typeof body.provider !== "string" || !body.provider) return null;
    if (typeof body.modelId !== "string" || !body.modelId) return null;
    edit.model = { provider: body.provider, modelId: body.modelId };
  }
  if (body.thinkingLevel !== undefined) {
    if (!isThinkingLevel(body.thinkingLevel)) return null;
    edit.thinkingLevel = body.thinkingLevel;
  }
  return edit;
}

/**
 * A refusal from inside the write step of a trust-and-write: thrown, so
 * `trustFreshFolderAndWrite()` takes the just-given trust back and the caller
 * answers with this response (the folder must not stay trusted by a save that
 * did not happen).
 */
class WriteRefusal extends Error {
  constructor(readonly response: Response) {
    super("write refused");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Save the model and/or reasoning level new sessions start with: globally
 * (`scope: "global"`, the default) or for one project (`scope: "project"`),
 * where `clear` removes saved project defaults instead.
 *
 * Picking a model for one chat is session-scoped, as in the TUI; this is the
 * explicit "save as default" behind the selectors' star. The cwd decides which
 * project settings could shadow the global value and which models are in
 * scope, so it goes through the same allow-list as `/api/models`. A project
 * write additionally goes through project trust, like every project write:
 * only to a folder a decision trusts, except `trustFolder` for a fresh folder,
 * which `trustFreshFolderAndWrite()` trusts first and then writes, as one step.
 */
export async function PUT(req: Request) {
  let body: DefaultPreferencesRequest;
  try {
    body = await req.json() as DefaultPreferencesRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const scope = body.scope === undefined ? "global" : body.scope;
  if (scope !== "global" && scope !== "project") {
    return Response.json({ error: `scope must be "global" or "project"` }, { status: 400 });
  }
  if (body.trustFolder !== undefined && typeof body.trustFolder !== "boolean") {
    return Response.json({ error: "trustFolder must be a boolean" }, { status: 400 });
  }
  let clear: ClearField[] = [];
  if (body.clear !== undefined) {
    if (scope !== "project") {
      return Response.json({ error: `clear is only valid with scope "project"` }, { status: 400 });
    }
    const parsed = parseClear(body.clear);
    if (!parsed) {
      return Response.json({ error: `clear must only contain "model" or "thinkingLevel"` }, { status: 400 });
    }
    clear = parsed;
  }
  const hasSetFields = body.provider !== undefined || body.modelId !== undefined || body.thinkingLevel !== undefined;
  const parsedEdit = hasSetFields ? parseEdit(body) : null;
  if (hasSetFields && !parsedEdit) {
    return Response.json({ error: "Expected provider and modelId, or a valid thinkingLevel" }, { status: 400 });
  }
  const edit: DefaultPreferencesEdit = parsedEdit ?? {};
  if (!edit.model && !edit.thinkingLevel && clear.length === 0) {
    return Response.json({ error: "Expected provider and modelId, or a valid thinkingLevel" }, { status: 400 });
  }
  if ((clear.includes("model") && edit.model) || (clear.includes("thinkingLevel") && edit.thinkingLevel)) {
    return Response.json({ error: "A field cannot be both set and cleared" }, { status: 400 });
  }

  const cwd = resolve(typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd());
  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    const agentDir = getAgentDir();
    const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
    // Trust-aware, as sessions build it: an untrusted project's settings file
    // must not shadow the global defaults here either.
    const createServices = () => createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: createEnabledModelsSettingsManager(cwd, agentDir),
      resourceLoaderOptions: { extensionFactories: [llamaCppExtension] },
      ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
    });

    if (scope === "global") {
      const services = await createServices();
      const { settingsManager } = services;

      const shadowed = shadowingProjectKeys(settingsManager, edit);
      if (shadowed.length > 0) {
        const settingsPath = projectSettingsPath(cwd);
        return Response.json({
          error: `${settingsPath} sets ${shadowed.join(", ")} for this project, so a global default would not apply here. Save it as this project's default instead.`,
          reason: "project-scope",
          settingsPath,
          keys: shadowed,
        }, { status: 409 });
      }

      if (edit.model) {
        // Only a model the selector can offer is a default that actually takes
        // effect: startup falls back to the first scoped model otherwise.
        const visible = await resolveVisibleModels(withDeferredProviderModels(services.modelRuntime), settingsManager.getEnabledModels());
        const { provider, modelId } = edit.model;
        if (!visible.visible.some((model) => model.provider === provider && model.id === modelId)) {
          return Response.json({ error: `Model not available: ${provider}/${modelId}` }, { status: 404 });
        }
      }

      await writeDefaultPreferences(settingsManager, edit);
      invalidateModelsCache();
      return Response.json({
        ok: true,
        ...(edit.model ? { defaultModel: edit.model } : {}),
        ...(edit.thinkingLevel ? { defaultThinkingLevel: edit.thinkingLevel } : {}),
      });
    }

    const settingsPath = projectSettingsPath(cwd);
    const status = getProjectTrustStatus(cwd, agentDir);
    // A folder that requires no trust and has no decision anywhere: writing
    // `.pi/settings.json` would make it require trust with no decision, so the
    // write needs the explicit trust-and-write step (or a refusal), not the
    // `trusted: true` a fresh folder reports by default (pi 1.5).
    const fresh = !status.requiresTrust && status.decision === null;

    const writeProject = async (): Promise<Response> => {
      // Built here, not outside: by now the trust decision is on disk, and the
      // settings manager must be able to write the project file.
      const services = await createServices();
      const { settingsManager } = services;
      if (edit.model) {
        const visible = await resolveVisibleModels(withDeferredProviderModels(services.modelRuntime), settingsManager.getEnabledModels());
        const { provider, modelId } = edit.model;
        if (!visible.visible.some((model) => model.provider === provider && model.id === modelId)) {
          throw new WriteRefusal(Response.json({ error: `Model not available: ${provider}/${modelId}` }, { status: 404 }));
        }
      }
      await writeProjectDefaultPreferences(settingsManager, { set: edit, clear });
      invalidateModelsCache();
      return Response.json({
        ok: true,
        scope: "project",
        ...(edit.model ? { defaultModel: edit.model } : {}),
        ...(edit.thinkingLevel ? { defaultThinkingLevel: edit.thinkingLevel } : {}),
        ...(clear.length > 0 ? { cleared: clear } : {}),
        settingsPath,
      });
    };

    if (status.trusted && !fresh) {
      return await writeProject();
    }
    if (body.trustFolder === true) {
      const result = await trustFreshFolderAndWrite(cwd, agentDir, writeProject, { knownFolders: allowedRoots });
      if (result.ok) return result.value;
      switch (result.reason) {
        case "folder-not-fresh": {
          // The folder changed since the panel offered the step (resources or
          // a decision appeared), so it is answered as the untrusted project
          // it now is, with its current status.
          const status = getProjectTrustStatus(cwd, agentDir);
          return Response.json({
            error: result.error,
            reason: "project-untrusted",
            settingsPath,
            trust: status,
          }, { status: 403 });
        }
        case "trust-too-broad":
          return Response.json({
            error: result.error,
            reason: "trust-too-broad",
            settingsPath,
            breadth: result.breadth,
          }, { status: 409 });
        case "trust-unreadable":
          return Response.json({ error: result.error, reason: "trust-unreadable", settingsPath }, { status: 409 });
        case "write-failed": {
          if (result.writeError instanceof WriteRefusal) return result.writeError.response;
          // The write's own error still says why nothing was saved; a rollback
          // that failed says the folder stays trusted instead.
          const error = result.rollbackError === undefined
            ? errorMessage(result.writeError)
            : `${errorMessage(result.writeError)}; the folder stays trusted, since taking the trust back failed: ${result.rollbackError}`;
          return Response.json({
            error,
            ...(isSdkUnsupportedError(result.writeError) ? { reason: "sdk-unsupported" } : {}),
            ...(result.rollbackError !== undefined ? { trustKept: true } : {}),
            ...(result.status ? { trust: result.status } : {}),
          }, { status: 500 });
        }
      }
    }
    if (fresh) {
      return Response.json({
        error: `Saving this project's default writes ${settingsPath}, which makes the folder require trust; trust it first, then save.`,
        reason: "trust-required",
        settingsPath,
      }, { status: 409 });
    }
    return Response.json({
      error: `This project is not trusted, so ${settingsPath} is not applied. Trust it from the Restricted banner, then save it as this project's default.`,
      reason: "project-untrusted",
      settingsPath,
    }, { status: 403 });
  } catch (error) {
    if (error instanceof WriteRefusal) return error.response;
    if (isSdkUnsupportedError(error)) {
      return Response.json({ error: error.message, reason: "sdk-unsupported" }, { status: 500 });
    }
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
