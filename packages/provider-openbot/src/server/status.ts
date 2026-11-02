import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities, formatModelSlugName } from "@t3tools/shared/model";
import { brandModelName } from "@t3tools/shared/modelBrandNames";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { OpenBotSettings } from "../settings.ts";
import { listAgents } from "./api.ts";
import { modelSlug, type OpenBotModelPair, readModels } from "./db.ts";

const OPENBOT_PRESENTATION = {
  displayName: "OpenBot",
  badgeLabel: "Beta",
  showInteractionModeToggle: false,
  reportsContextWindow: false,
  // OpenBot agents run their own tools under OpenBot's own approvals.
  supportedRuntimeModes: ["full-access"],
} as const;

const snapshotFor = (
  settings: OpenBotSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  models: ReadonlyArray<ServerProviderModel>,
) =>
  buildServerProvider({
    presentation: OPENBOT_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: providerModelsFromSettings(models, settings.customModels, null),
    slashCommands: [],
    probe,
  });

export const makePendingOpenBotProvider = Effect.fn("makePendingOpenBotProvider")(function* (
  settings: OpenBotSettings,
) {
  return snapshotFor(
    settings,
    DateTime.formatIso(yield* DateTime.now),
    {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Connecting to OpenBot..."
        : "OpenBot is disabled in T3 Code settings.",
    },
    [],
  );
});

const providerLabel = (provider: string) => provider.charAt(0).toUpperCase() + provider.slice(1);

/** The name T3 shows this model by everywhere else: "Claude Opus 5.5", "GPT-6.1-Sol". */
const modelName = (provider: string, model: string) => {
  const named = formatModelSlugName(model);
  return named === model ? brandModelName(provider, model) : named;
};

const REASONING_EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
} as const;
type ReasoningEffort = keyof typeof REASONING_EFFORT_LABELS;

const isReasoningEffort = (value: string | undefined): value is ReasoningEffort =>
  value !== undefined && Object.hasOwn(REASONING_EFFORT_LABELS, value);

/**
 * OpenBot's reasoning efforts. It learns each model's levels from the provider CLI and does not
 * expose them, so this offers all of them but Haiku's and lets OpenBot refuse one a model lacks.
 * The default is the effort the agents on this model use, as OpenBot falls back to high.
 */
const effortCapabilities = (pair: OpenBotModelPair) => {
  const efforts: ReadonlyArray<ReasoningEffort> = pair.model.startsWith("claude-haiku")
    ? ["medium"]
    : ["low", "medium", "high", "xhigh", "max"];
  const effort =
    isReasoningEffort(pair.effort) && efforts.includes(pair.effort)
      ? pair.effort
      : efforts.includes("high")
        ? "high"
        : "medium";
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: effort,
        options: efforts.map((id) => ({
          id,
          label: REASONING_EFFORT_LABELS[id],
          ...(id === effort ? { isDefault: true } : {}),
        })),
      },
    ],
  });
};

/**
 * The models are OpenBot's provider and model pairs; picking one moves the thread's agent to it.
 * Agents are not models: a thread keeps the agent whose conversation it opened.
 */
export const checkOpenBotProviderStatus = Effect.fn("checkOpenBotProviderStatus")(function* (
  settings: OpenBotSettings,
) {
  if (!settings.enabled) return yield* makePendingOpenBotProvider(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.all([listAgents(settings), readModels(settings)], {
    concurrency: "unbounded",
  }).pipe(
    Effect.map(([agents, models]) =>
      snapshotFor(
        settings,
        checkedAt,
        agents.length === 0
          ? {
              installed: true,
              version: null,
              status: "warning",
              auth: { status: "authenticated" },
              message: "No OpenBot agent has Local scripts on. Turn them on in OpenBot to message an agent.",
            }
          : { installed: true, version: null, status: "ready", auth: { status: "authenticated" } },
        models.map((pair, index) => ({
          slug: modelSlug(pair.provider, pair.model),
          name: modelName(pair.provider, pair.model),
          subProvider: providerLabel(pair.provider),
          isCustom: false,
          isDefault: index === 0,
          capabilities: effortCapabilities(pair),
        })),
      ),
    ),
    Effect.catch((error) =>
      Effect.succeed(
        snapshotFor(
          settings,
          checkedAt,
          {
            installed: error.status !== undefined,
            version: null,
            status: "error",
            auth: { status: error.status === 401 ? "unauthenticated" : "unknown" },
            message: error.detail,
          },
          [],
        ),
      ),
    ),
  );
});
