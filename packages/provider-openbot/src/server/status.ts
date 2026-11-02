import type { ServerProviderModel } from "@t3tools/contracts";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { OpenBotSettings } from "../settings.ts";
import { listAgents } from "./api.ts";
import { modelSlug, readModels } from "./db.ts";

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

/**
 * The models are OpenBot's provider and model pairs; picking one moves the thread's agent to it.
 * Agents are not models: each T3 thread belongs to one agent, opened from the sidebar.
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
          name: pair.model,
          subProvider: providerLabel(pair.provider),
          isCustom: false,
          isDefault: index === 0,
          capabilities: null,
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
