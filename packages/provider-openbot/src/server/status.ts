import type { ServerProviderModel } from "@t3tools/contracts";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { OpenBotSettings } from "../settings.ts";
import { configDirOf, listAgents } from "./api.ts";

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

/** Each agent with Local scripts on is a model: picking one is picking who to message. */
export const checkOpenBotProviderStatus = Effect.fn("checkOpenBotProviderStatus")(function* (
  settings: OpenBotSettings,
) {
  if (!settings.enabled) return yield* makePendingOpenBotProvider(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* listAgents(configDirOf(settings)).pipe(
    Effect.map((agents) =>
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
        agents.map((agent, index) => ({
          slug: agent.id,
          name: agent.name,
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
