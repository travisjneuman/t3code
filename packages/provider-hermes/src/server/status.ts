import type { ServerProviderModel } from "@t3tools/contracts";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { HermesSettings } from "../settings.ts";
import { connectionOf, modelOptions } from "./api.ts";
import { HERMES_DEFAULT_MODEL_ENTRY, hermesModelsFromOptions } from "./models.ts";

const HERMES_PRESENTATION = {
  displayName: "Hermes Agent",
  badgeLabel: "Beta",
  showInteractionModeToggle: true,
  reportsContextWindow: false,
  // Hermes runs its own tools on its own host; T3 has no approval mode to apply there.
  supportedRuntimeModes: ["full-access"],
} as const;

const snapshotFor = (
  settings: HermesSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  models: ReadonlyArray<ServerProviderModel>,
) =>
  buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: providerModelsFromSettings(models, settings.customModels, null),
    slashCommands: [],
    probe,
  });

export const makePendingHermesProvider = Effect.fn("makePendingHermesProvider")(function* (
  settings: HermesSettings,
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
        ? "Connecting to Hermes Agent..."
        : "Hermes Agent is disabled in T3 Code settings.",
    },
    [HERMES_DEFAULT_MODEL_ENTRY],
  );
});

/** Reads the model options over HTTP: that proves the URL, the key, and the catalog at once. */
export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  settings: HermesSettings,
) {
  if (!settings.enabled) return yield* makePendingHermesProvider(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.apiUrl)
    return snapshotFor(
      settings,
      checkedAt,
      {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Set the Hermes API URL and key in Settings › Providers › Hermes Agent.",
      },
      [HERMES_DEFAULT_MODEL_ENTRY],
    );
  return yield* modelOptions(connectionOf(settings)).pipe(
    Effect.map((body) =>
      snapshotFor(
        settings,
        checkedAt,
        { installed: true, version: null, status: "ready", auth: { status: "authenticated" } },
        hermesModelsFromOptions(body, settings.hiddenProviders),
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
          [HERMES_DEFAULT_MODEL_ENTRY],
        ),
      ),
    ),
  );
});
