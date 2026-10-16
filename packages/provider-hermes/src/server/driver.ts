import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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

import { HermesSettings } from "../settings.ts";
import { makeHermesAdapterV2 } from "./adapter.ts";
import { checkHermesProviderStatus, makePendingHermesProvider } from "./status.ts";
import { hermesTextGeneration } from "./textGeneration.ts";

const DRIVER_KIND = ProviderDriverKind.make("hermes");
const decodeHermesSettings = Schema.decodeSync(HermesSettings);
// Hermes runs on its own machine; T3 neither installs nor updates it.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type HermesDriverEnv =
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost
  | FileSystem.FileSystem;

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Hermes Agent", supportsMultipleInstances: true },
  configSchema: HermesSettings,
  defaultConfig: () => decodeHermesSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const effectiveConfig = { ...config, enabled } satisfies HermesSettings;
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
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<HermesSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingHermesProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkHermesProviderStatus(effectiveConfig).pipe(Effect.map(stampIdentity)),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Hermes Agent snapshot.",
              cause,
            }),
        ),
      );
      const orchestrationAdapter = yield* makeHermesAdapterV2({
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
        textGeneration: hermesTextGeneration,
      } satisfies ProviderInstance;
    }),
};
