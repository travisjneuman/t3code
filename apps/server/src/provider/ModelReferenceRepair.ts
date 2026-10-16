// Fork add-on: rewrites saved references to a model the provider retired.
// It follows a model's `supersedes`, never its `aliases`: an alias such as "opus" or "default" is
// a floating shorthand the user may have chosen on purpose, while a superseded id no longer exists.
import type {
  ModelSelection,
  ProjectSettingsOverrides,
  ProviderInstanceId,
  ServerProvider,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Settings from "../serverSettings.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

/** Retired slug → successor slug, per provider instance. */
export type ModelRenames = ReadonlyMap<ProviderInstanceId, ReadonlyMap<string, string>>;

const WORKER_SELECTION_KEYS = [
  "agentWorkerModelSelection",
  "agentReviewWorkerModelSelection",
  "agentResearchWorkerModelSelection",
] as const;

const SELECTION_KEYS = [
  "defaultModelSelection",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  ...WORKER_SELECTION_KEYS,
] as const;

/**
 * Only a complete snapshot may drive a rewrite. Pi reports a failed discovery
 * as ready with just its `default` model, so a missing slug alone proves
 * nothing; the successor itself must be listed, and the retired slug not.
 */
export function collectModelRenames(providers: ReadonlyArray<ServerProvider>): ModelRenames {
  const renames = new Map<ProviderInstanceId, Map<string, string>>();
  for (const provider of providers) {
    if (!provider.enabled || provider.auth.status !== "authenticated") continue;
    const listed = new Set(provider.models.map((model) => model.slug));
    for (const model of provider.models) {
      for (const retired of model.supersedes ?? []) {
        if (listed.has(retired)) continue;
        const instanceRenames = renames.get(provider.instanceId) ?? new Map<string, string>();
        instanceRenames.set(retired, model.slug);
        renames.set(provider.instanceId, instanceRenames);
      }
    }
  }
  return renames;
}

function repairSelection<T extends ModelSelection | null | undefined>(
  selection: T,
  renames: ModelRenames,
): T {
  if (!selection) return selection;
  const successor = renames.get(selection.instanceId)?.get(selection.model);
  return successor === undefined ? selection : { ...selection, model: successor };
}

function repairSlugList(
  slugs: ReadonlyArray<string>,
  renames: ReadonlyMap<string, string>,
): ReadonlyArray<string> {
  const out: Array<string> = [];
  for (const slug of slugs) {
    const next = renames.get(slug) ?? slug;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

type SelectionFields = Partial<Record<(typeof SELECTION_KEYS)[number], ModelSelection | null>>;

function repairSelectionFields<T extends SelectionFields>(
  fields: T,
  renames: ModelRenames,
  keys: ReadonlyArray<(typeof SELECTION_KEYS)[number]>,
): T {
  let next = fields;
  for (const key of keys) {
    if (!(key in fields)) continue;
    const repaired = repairSelection(fields[key], renames);
    if (repaired !== fields[key]) next = { ...next, [key]: repaired };
  }
  return next;
}

/** The patch that moves every saved reference to a retired slug onto its successor. */
export function buildModelReferenceRepairPatch(
  settings: ServerSettings,
  renames: ModelRenames,
): ServerSettingsPatch | null {
  if (renames.size === 0) return null;
  const patch: Record<string, unknown> = {};

  for (const key of SELECTION_KEYS) {
    const current = settings[key];
    const repaired = repairSelection(current, renames);
    if (repaired !== current) patch[key] = repaired;
  }

  let presetsChanged = false;
  const agentPresets = settings.agentPresets.map((preset) => {
    const repaired = repairSelectionFields(preset.settings, renames, WORKER_SELECTION_KEYS);
    if (repaired === preset.settings) return preset;
    presetsChanged = true;
    return { ...preset, settings: repaired };
  });
  if (presetsChanged) patch.agentPresets = agentPresets;

  const overrides: Record<string, ProjectSettingsOverrides> = {};
  for (const [projectId, entry] of Object.entries(settings.projectSettingsOverrides)) {
    const repaired = repairSelectionFields(entry, renames, SELECTION_KEYS);
    if (repaired !== entry) overrides[projectId] = repaired;
  }
  if (Object.keys(overrides).length > 0) patch.projectSettingsOverrides = overrides;

  if (settings.providerModelPreferences) {
    let changed = false;
    const preferences = Object.fromEntries(
      Object.entries(settings.providerModelPreferences).map(([instanceId, entry]) => {
        const instanceRenames = renames.get(instanceId as ProviderInstanceId);
        if (!instanceRenames) return [instanceId, entry];
        const hiddenModels = repairSlugList(entry.hiddenModels, instanceRenames);
        const modelOrder = repairSlugList(entry.modelOrder, instanceRenames);
        const same =
          hiddenModels.every((slug, index) => slug === entry.hiddenModels[index]) &&
          hiddenModels.length === entry.hiddenModels.length &&
          modelOrder.every((slug, index) => slug === entry.modelOrder[index]) &&
          modelOrder.length === entry.modelOrder.length;
        if (same) return [instanceId, entry];
        changed = true;
        return [instanceId, { hiddenModels, modelOrder }];
      }),
    );
    if (changed) patch.providerModelPreferences = preferences;
  }

  if (settings.favorites) {
    const favorites: Array<{ provider: ProviderInstanceId; model: string }> = [];
    for (const favorite of settings.favorites) {
      const model = renames.get(favorite.provider)?.get(favorite.model) ?? favorite.model;
      if (!favorites.some((entry) => entry.provider === favorite.provider && entry.model === model))
        favorites.push({ provider: favorite.provider, model });
    }
    const same =
      favorites.length === settings.favorites.length &&
      favorites.every((entry, index) => entry.model === settings.favorites?.[index]?.model);
    if (!same) patch.favorites = favorites;
  }

  return Object.keys(patch).length === 0 ? null : (patch as ServerSettingsPatch);
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const serverSettings = yield* Settings.ServerSettingsService;
    const repair = (snapshot: ReadonlyArray<ServerProvider>) =>
      Effect.gen(function* () {
        const renames = collectModelRenames(snapshot);
        if (renames.size === 0) return;
        const patch = buildModelReferenceRepairPatch(yield* serverSettings.getSettings, renames);
        if (patch === null) return;
        yield* serverSettings.updateSettings(patch);
        yield* Effect.logInfo("Moved saved model references to their successors.", {
          renames: Object.fromEntries(
            [...renames].map(([instanceId, slugs]) => [instanceId, Object.fromEntries(slugs)]),
          ),
          keys: Object.keys(patch),
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to repair saved model references.", cause),
        ),
      );
    yield* Effect.gen(function* () {
      yield* repair(yield* providers.getProviders);
      yield* providers.streamChanges.pipe(Stream.runForEach(repair));
    }).pipe(Effect.forkScoped);
  }),
);
