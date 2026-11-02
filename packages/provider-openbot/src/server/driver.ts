import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

import { OpenBotSettings } from "../settings.ts";
import { makeOpenBotAdapterV2 } from "./adapter.ts";
import { checkOpenBotProviderStatus, makePendingOpenBotProvider } from "./status.ts";
import { openbotTextGeneration } from "./textGeneration.ts";
import { openBotUsageReader } from "./usage.ts";

const DRIVER_KIND = ProviderDriverKind.make("openbot");
const decodeOpenBotSettings = Schema.decodeSync(OpenBotSettings);
// OpenBot is its own desktop app; T3 neither installs nor updates it.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type OpenBotDriverEnv = IdAllocator.IdAllocatorV2 | ProviderHost.ProviderHost;

export const OpenBotDriver: ProviderDriver<OpenBotSettings, OpenBotDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "OpenBot", supportsMultipleInstances: true },
  configSchema: OpenBotSettings,
  defaultConfig: () => decodeOpenBotSettings({}),
  usage: openBotUsageReader,
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const effectiveConfig = { ...config, enabled } satisfies OpenBotSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OpenBotSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingOpenBotProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkOpenBotProviderStatus(effectiveConfig).pipe(Effect.map(stampIdentity)),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build OpenBot snapshot.",
              cause,
            }),
        ),
      );
      const orchestrationAdapter = yield* makeOpenBotAdapterV2({
        instanceId,
        settings: effectiveConfig,
      });
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration: openbotTextGeneration,
      } satisfies ProviderInstance;
    }),
};
