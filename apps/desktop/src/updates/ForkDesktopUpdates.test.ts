import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import * as ForkDesktopUpdates from "./ForkDesktopUpdates.ts";
import * as LocalSourceUpdates from "./LocalSourceUpdates.ts";

const UPSTREAM_TAG = "v0.0.46-nightly.20261003.9";
const UPSTREAM_VERSION = "0.0.46-nightly.20261003.9";

const inspection: LocalSourceUpdates.LocalSourceUpdateInspection = {
  repositoryPath: "/repo",
  currentCommit: "a".repeat(40),
  upstreamTag: UPSTREAM_TAG,
  upstreamVersion: UPSTREAM_VERSION,
  upstreamCommit: "b".repeat(40),
  ahead: 4,
  behind: 3,
};

const sourceError = (operation: "inspect" | "merge", detail: string) =>
  new LocalSourceUpdates.LocalSourceUpdateError({
    operation,
    repositoryPath: "/repo",
    detail,
    cause: new Error(detail),
  });

interface HarnessOptions {
  readonly enabled?: boolean;
  readonly inspect?: Effect.Effect<
    LocalSourceUpdates.LocalSourceUpdateInspection,
    LocalSourceUpdates.LocalSourceUpdateError
  >;
  readonly syncSource?: Effect.Effect<
    LocalSourceUpdates.LocalSourceSyncResult,
    LocalSourceUpdates.LocalSourceUpdateError
  >;
}

function makeHarness(options: HarnessOptions = {}) {
  const steps: string[] = [];
  const sentStates: DesktopUpdateState[] = [];

  const layerLocalSource = Layer.succeed(LocalSourceUpdates.LocalSourceUpdates, {
    enabled: Effect.succeed(options.enabled ?? true),
    repositoryPath: Option.some("/repo"),
    inspect: options.inspect ?? Effect.succeed(inspection),
    syncAndBuild: Effect.sync(() => {
      steps.push("syncAndBuild");
      return {
        version: UPSTREAM_VERSION,
        applicationBundlePath: "/state/source-updates/build/ndev.t3code.app",
        push: { pushed: true } as const,
      };
    }),
    install: Effect.sync(() => {
      steps.push("install");
    }),
    syncSource:
      options.syncSource ??
      Effect.succeed({ merged: 0, upstreamTag: UPSTREAM_TAG, push: null }),
    autoSyncSource: Effect.succeed({ merged: 0, upstreamTag: UPSTREAM_TAG, push: null }),
  } satisfies LocalSourceUpdates.LocalSourceUpdates["Service"]);

  const layerApp = Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("ndev.t3code"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    quit: Effect.sync(() => {
      steps.push("quit");
    }),
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);

  const layerWindow = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeedNone,
    currentMainOrFirst: Effect.succeedNone,
    focusedMainOrFirst: Effect.succeedNone,
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: (_channel, state) =>
      Effect.sync(() => {
        sentStates.push(state as DesktopUpdateState);
      }),
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const layerBackend = DesktopBackendPool.layerTest([
    {
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: Effect.succeed("Local"),
      start: Effect.sync(() => {
        steps.push("startBackend");
      }),
      stop: () =>
        Effect.sync(() => {
          steps.push("stopBackend");
        }),
      currentConfig: Effect.succeedNone,
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 0,
        restartScheduled: false,
      }),
      waitForReady: () => Effect.succeed(true),
    },
  ]);

  const configLayer = DesktopConfig.layerTest({
    T3CODE_HOME: `/tmp/t3-fork-desktop-updates-test-${process.pid}`,
  });
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: `/tmp/t3-fork-desktop-updates-home-${process.pid}`,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "0.0.45-nightly.20260901.10",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, configLayer)));

  // Keeps the restart marker off the disk.
  const layerFileSystem = FileSystem.layerNoop({
    makeDirectory: () => Effect.void,
    writeFileString: () => Effect.void,
    remove: () => Effect.void,
  });

  const layerUpdates = Layer.effect(
    DesktopUpdates.DesktopUpdates,
    ForkDesktopUpdates.makeLocalSource,
  );
  const layer = layerUpdates.pipe(
    Layer.provide(layerFileSystem),
    Layer.provideMerge(layerLocalSource),
    Layer.provideMerge(layerApp),
    Layer.provideMerge(layerWindow),
    Layer.provideMerge(layerBackend),
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(DesktopAppSettings.layer),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(NodeServices.layer),
  );

  return { layer, steps, sentStates };
}

describe("ForkDesktopUpdates", () => {
  it.effect("offers the newest upstream nightly as a source update", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.isTrue(Option.isNone(yield* updates.disabledReason));

        const result = yield* updates.check("test");
        assert.isTrue(result.checked);
        assert.equal(result.state.status, "available");
        assert.equal(result.state.availableVersion, UPSTREAM_VERSION);
        assert.equal(result.state.sourceUpdate, true);
        assert.equal(harness.sentStates.at(-1)?.status, "available");
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("reports a failed inspection as a check error", () => {
    const harness = makeHarness({ inspect: Effect.fail(sourceError("inspect", "no origin")) });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const result = yield* updates.check("test");
        assert.equal(result.state.status, "error");
        assert.equal(result.state.errorContext, "check");
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("builds the source update, then installs it and quits", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("test");

        const download = yield* updates.download;
        assert.isTrue(download.completed);
        assert.equal(download.state.status, "downloaded");
        assert.equal(download.state.downloadedVersion, UPSTREAM_VERSION);

        const install = yield* updates.install;
        assert.isTrue(install.accepted);
        assert.deepStrictEqual(harness.steps, ["syncAndBuild", "stopBackend", "install", "quit"]);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("says when the fork push was skipped after a sync", () => {
    const harness = makeHarness({
      syncSource: Effect.succeed({
        merged: 2,
        upstreamTag: UPSTREAM_TAG,
        push: { pushed: false, reason: "fatal: permission denied" },
      }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const result = yield* ForkDesktopUpdates.syncSource;
        assert.deepStrictEqual(result, {
          ok: true,
          merged: 2,
          message:
            "Merged 2 official commits. The push to origin was skipped: fatal: permission denied",
        });
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("returns sync failures as a message", () => {
    const harness = makeHarness({ syncSource: Effect.fail(sourceError("merge", "conflict")) });
    return Effect.gen(function* () {
      const result = yield* ForkDesktopUpdates.syncSource;
      assert.isFalse(result.ok);
      assert.equal(result.merged, 0);
      assert.include(result.message, "conflict");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses to sync outside local source builds", () => {
    const harness = makeHarness({ enabled: false });
    return Effect.gen(function* () {
      const result = yield* ForkDesktopUpdates.syncSource;
      assert.deepStrictEqual(result, {
        ok: false,
        merged: 0,
        message: "Syncing is only available in local source builds.",
      });
    }).pipe(Effect.provide(harness.layer));
  });
});
