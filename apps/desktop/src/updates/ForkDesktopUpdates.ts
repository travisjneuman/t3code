// Fork add-on: replaces DesktopUpdates.layer. A packaged macOS build that
// records a source checkout updates by merging the official nightly into that
// checkout and building it; every other build uses upstream's updater as is.
import {
  DESKTOP_UPDATE_RESTART_MARKER_FILE,
  type DesktopSourceSyncResult,
  type DesktopUpdateActionResult,
  type DesktopUpdateChannel,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import * as LocalSourceUpdates from "./LocalSourceUpdates.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

// Merging and building take minutes, so the source poller runs far less often
// than upstream's feed poller.
const SOURCE_SYNC_STARTUP_DELAY = "1 minute";
const SOURCE_SYNC_POLL_INTERVAL = "30 minutes";
const PREPARED_INSTALL_CHECK_WAIT = Duration.seconds(90);

type UpdateAction = "check" | "download" | "install" | "install-recovery" | "channel";

const {
  logInfo: logUpdaterInfo,
  logWarning: logUpdaterWarning,
  logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("desktop-updater");

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

function createSourceUpdateState(
  channel: DesktopUpdateChannel,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): DesktopUpdateState {
  return {
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, channel),
    enabled: true,
    status: "idle",
    sourceUpdate: true,
  };
}

/**
 * The local source updater. It keeps upstream's state machine, action
 * reservation, broadcast, and install recovery; check inspects the checkout,
 * download merges and builds it, and install swaps the built app in on quit.
 */
export const makeLocalSource = Effect.gen(function* () {
  const localSourceUpdates = yield* LocalSourceUpdates.LocalSourceUpdates;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const desktopState = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;

  const activeUpdateActionRef = yield* Ref.make<Option.Option<UpdateAction>>(Option.none());
  const finishedUpdateActions = yield* PubSub.unbounded<UpdateAction>();
  const updaterConfiguredRef = yield* Ref.make(false);
  const updateStateRef = yield* Ref.make<DesktopUpdateState>({
    ...createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      environment.defaultDesktopSettings.updateChannel,
    ),
    sourceUpdate: true,
  });

  const stateChanges = yield* PubSub.sliding<DesktopUpdateState>(16);
  // Makes ref writes + publishes atomic against subscribe, so a snapshot
  // never overlaps with the first change a subscriber receives.
  const stateMutex = yield* Semaphore.make(1);

  const emitState = Ref.get(updateStateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );

  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    stateMutex
      .withPermits(1)(
        Ref.set(updateStateRef, state).pipe(Effect.andThen(PubSub.publish(stateChanges, state))),
      )
      .pipe(Effect.andThen(emitState));

  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    Ref.get(updateStateRef).pipe(
      Effect.flatMap((state) => {
        const nextState = f(state);
        return setState(nextState).pipe(Effect.as(nextState));
      }),
    );

  const activeUpdateAction = Ref.get(activeUpdateActionRef);

  const tryStartUpdateAction = (action: UpdateAction): Effect.Effect<boolean> =>
    Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) ? [false, activeAction] : [true, Option.some(action)],
    );

  const tryStartChannelChange = Ref.modify(activeUpdateActionRef, (activeAction) =>
    Option.isSome(activeAction)
      ? [activeAction, activeAction]
      : [Option.none<UpdateAction>(), Option.some<UpdateAction>("channel")],
  );

  const finishUpdateAction = (action: UpdateAction): Effect.Effect<void> =>
    Ref.modify(activeUpdateActionRef, (activeAction) => {
      const finished = Option.isSome(activeAction) && activeAction.value === action;
      return [finished, finished ? Option.none() : activeAction] as const;
    }).pipe(
      Effect.flatMap((finished) =>
        finished ? PubSub.publish(finishedUpdateActions, action).pipe(Effect.asVoid) : Effect.void,
      ),
    );

  const checkForUpdates = Effect.fn("desktop.updates.checkForUpdates")(function* (reason: string) {
    yield* Effect.annotateCurrentSpan({ reason });
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;

    const state = yield* Ref.get(updateStateRef);
    if (state.status === "downloading") {
      yield* logUpdaterInfo("skipping update check while update is active", {
        reason,
        status: state.status,
      });
      return false;
    }

    if (!(yield* tryStartUpdateAction("check"))) return false;

    return yield* Effect.gen(function* () {
      const checkedAt = yield* currentIsoTimestamp;
      yield* setState(reduceDesktopUpdateStateOnCheckStart(state, checkedAt));
      yield* logUpdaterInfo("checking for updates", { reason });

      const inspection = yield* localSourceUpdates.inspect;
      // A build that predates the newest nightly still needs one, even when
      // a sync already merged it.
      if (inspection.behind === 0 && environment.appVersion === inspection.upstreamVersion) {
        yield* updateState((current) => reduceDesktopUpdateStateOnNoUpdate(current, checkedAt));
        yield* logUpdaterInfo("no updates available");
        return true;
      }
      yield* updateState((current) =>
        reduceDesktopUpdateStateOnUpdateAvailable(current, inspection.upstreamVersion, checkedAt),
      );
      yield* logUpdaterInfo("upstream nightly available for the local source build", {
        ahead: inspection.ahead,
        behind: inspection.behind,
        currentCommit: inspection.currentCommit,
        upstreamTag: inspection.upstreamTag,
        upstreamCommit: inspection.upstreamCommit,
      });
      return true;
    }).pipe(
      Effect.catchTag(
        "LocalSourceUpdateError",
        Effect.fn("desktop.updates.handleCheckForUpdatesFailure")(function* (error) {
          const failedAt = yield* currentIsoTimestamp;
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnCheckFailure(current, error.message, failedAt),
          );
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            operation: error.operation,
          });
          return true;
        }),
      ),
      Effect.onInterrupt(() => setState(state)),
      Effect.ensuring(finishUpdateAction("check")),
    );
  });

  const downloadAvailableUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    if (!(yield* Ref.get(updaterConfiguredRef)) || state.status !== "available") {
      return { accepted: false, completed: false };
    }

    if (!(yield* tryStartUpdateAction("download"))) {
      return { accepted: false, completed: false };
    }

    return yield* Effect.gen(function* () {
      yield* setState(reduceDesktopUpdateStateOnDownloadStart(state));
      yield* logUpdaterInfo("merging upstream nightly and building local source update");
      const build = yield* localSourceUpdates.syncAndBuild;
      yield* updateState((current) =>
        reduceDesktopUpdateStateOnDownloadComplete(current, build.version),
      );
      yield* logUpdaterInfo("update downloaded", {
        version: build.version,
        pushed: build.push.pushed,
      });
      return { accepted: true, completed: true };
    }).pipe(
      Effect.catchTag(
        "LocalSourceUpdateError",
        Effect.fn("desktop.updates.handleDownloadFailure")(function* (error) {
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
          );
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            operation: error.operation,
          });
          return { accepted: true, completed: false };
        }),
      ),
      Effect.onInterrupt(() =>
        updateState((current) => (current.status === "downloading" ? state : current)).pipe(
          Effect.asVoid,
        ),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const error = new DesktopUpdates.DesktopUpdateUnexpectedActionError({
          action: "download",
          cause,
        });
        return Effect.gen(function* () {
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
          );
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            action: error.action,
          });
          return { accepted: true, completed: false };
        });
      }),
      Effect.ensuring(finishUpdateAction("download")),
    );
  }).pipe(Effect.withSpan("desktop.updates.downloadAvailableUpdate"));

  // Tells the primary backend that the coming stop is an update restart, so it
  // keeps its managed tunnel for the backend the updated app starts.
  const updateRestartMarkerDir = environment.path.join(environment.baseDir, "runtime");
  const updateRestartMarkerPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_RESTART_MARKER_FILE,
  );
  const writeUpdateRestartMarker = fileSystem
    .makeDirectory(updateRestartMarkerDir, { recursive: true })
    .pipe(
      Effect.andThen(fileSystem.writeFileString(updateRestartMarkerPath, "")),
      Effect.catch((error) =>
        logUpdaterWarning("Could not write the update restart marker.", { errorTag: error._tag }),
      ),
    );

  const removeUpdateRestartMarker = fileSystem
    .remove(updateRestartMarkerPath, { force: true })
    .pipe(Effect.ignore);

  const resetInstallAction = Effect.all(
    [
      finishUpdateAction("install"),
      Ref.set(desktopState.quitting, false),
      removeUpdateRestartMarker,
    ],
    { discard: true },
  );

  const recoverFailedInstall = Effect.fn("desktop.updates.recoverFailedInstall")(function* (
    message: string,
  ) {
    const ownsRecovery = yield* Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) && activeAction.value === "install"
        ? ([true, Option.some<UpdateAction>("install-recovery")] as const)
        : ([false, activeAction] as const),
    );
    if (!ownsRecovery) return;

    yield* Ref.set(desktopState.quitting, false);
    yield* removeUpdateRestartMarker;
    yield* Effect.gen(function* () {
      const instances = yield* pool.list;
      const restartExit = yield* Effect.forEach(instances, (instance) => instance.start, {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.exit);
      yield* updateState((current) => reduceDesktopUpdateStateOnInstallFailure(current, message));
      if (Exit.isFailure(restartExit)) {
        yield* logUpdaterError("Desktop update install recovery could not restart every backend.");
      }
    }).pipe(
      Effect.catchCause(() =>
        logUpdaterError("Desktop update install recovery failed unexpectedly."),
      ),
      Effect.ensuring(finishUpdateAction("install-recovery")),
    );
  });

  const installDownloadedUpdate = (expectedVersion?: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const actionCompletions = yield* PubSub.subscribe(finishedUpdateActions);
        let admission: "admitted" | "refused" | "wait-for-check" = "wait-for-check";
        while (admission === "wait-for-check") {
          admission = yield* stateMutex.withPermits(1)(
            Effect.gen(function* () {
              const state = yield* Ref.get(updateStateRef);
              const activeAction = yield* Ref.get(activeUpdateActionRef);
              const hasExpectedDownload =
                state.downloadedVersion !== null &&
                (expectedVersion === undefined || state.downloadedVersion === expectedVersion);
              if (
                (yield* Ref.get(desktopState.quitting)) ||
                !(yield* Ref.get(updaterConfiguredRef)) ||
                !hasExpectedDownload
              ) {
                return "refused" as const;
              }
              if (Option.isSome(activeAction)) {
                return activeAction.value === "check" && expectedVersion !== undefined
                  ? ("wait-for-check" as const)
                  : ("refused" as const);
              }
              const hasInstallableDownload =
                state.status === "downloaded" ||
                (state.status === "error" &&
                  (state.errorContext === null || state.errorContext === "install"));
              if (!hasInstallableDownload) return "refused" as const;
              return (yield* tryStartUpdateAction("install"))
                ? ("admitted" as const)
                : ("refused" as const);
            }),
          );
          if (admission === "wait-for-check") {
            const finishedAction = yield* PubSub.take(actionCompletions).pipe(
              Effect.timeoutOption(PREPARED_INSTALL_CHECK_WAIT),
            );
            if (Option.isNone(finishedAction)) {
              admission = "refused";
            }
          }
        }
        if (admission === "refused") {
          return { accepted: false, completed: false, failed: false };
        }

        yield* Ref.set(desktopState.quitting, true);

        return yield* Effect.gen(function* () {
          yield* writeUpdateRestartMarker;
          const instances = yield* pool.list;
          yield* Effect.forEach(
            instances,
            (instance) => instance.stop({ timeout: Duration.seconds(5) }),
            { concurrency: "unbounded" },
          );
          // The helper waits for this process to exit, swaps the built app
          // in, and opens it.
          yield* localSourceUpdates.install;
          yield* electronApp.quit;
          return { accepted: true, completed: false, failed: false };
        }).pipe(
          Effect.catchTag(
            "LocalSourceUpdateError",
            Effect.fn("desktop.updates.handleInstallFailure")(function* (error) {
              yield* recoverFailedInstall(error.message);
              yield* logUpdaterError(error.message, {
                errorTag: error._tag,
                operation: error.operation,
              });
              return { accepted: true, completed: false, failed: true };
            }),
          ),
          Effect.onInterrupt(() => resetInstallAction),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) {
                return yield* Effect.failCause(cause);
              }
              const error = new DesktopUpdates.DesktopUpdateUnexpectedActionError({
                action: "install",
                cause,
              });
              yield* recoverFailedInstall(error.message);
              yield* logUpdaterError(error.message, {
                errorTag: error._tag,
                action: error.action,
              });
              return { accepted: true, completed: false, failed: true };
            }),
          ),
        );
      }),
    ).pipe(Effect.withSpan("desktop.updates.installDownloadedUpdate"));

  const installWithExpectedVersion = Effect.fn("desktop.updates.install")(function* (
    expectedVersion?: string,
  ) {
    if (yield* Ref.get(desktopState.quitting)) {
      return {
        accepted: false,
        completed: false,
        failed: false,
        state: yield* Ref.get(updateStateRef),
      };
    }
    const result = yield* installDownloadedUpdate(expectedVersion);
    return {
      accepted: result.accepted,
      completed: result.completed,
      failed: result.failed,
      state: yield* Ref.get(updateStateRef),
    };
  });

  // Merges each new upstream nightly into the checkout in the background, so
  // the update button only has to build it.
  const syncSourceOnce = localSourceUpdates.autoSyncSource.pipe(
    Effect.tap((result) =>
      logUpdaterInfo("background source sync finished", { merged: result.merged }),
    ),
    Effect.andThen(checkForUpdates("source-sync")),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : logUpdaterWarning("background source sync skipped", { cause: Cause.pretty(cause) }),
    ),
  );

  const startSourceSyncPoller: Effect.Effect<void, never, Scope.Scope> = Effect.sleep(
    SOURCE_SYNC_STARTUP_DELAY,
  ).pipe(
    Effect.andThen(
      syncSourceOnce.pipe(Effect.andThen(Effect.sleep(SOURCE_SYNC_POLL_INTERVAL)), Effect.forever),
    ),
    Effect.catchCause(() => Effect.void),
    Effect.withSpan("desktop.updates.startSourceSyncPoller"),
    Effect.forkScoped,
    Effect.asVoid,
  );

  return DesktopUpdates.DesktopUpdates.of({
    getState: Ref.get(updateStateRef),
    isActionActive: activeUpdateAction.pipe(Effect.map(Option.isSome)),
    isInstallActive: activeUpdateAction.pipe(
      Effect.map((action) => Option.isSome(action) && action.value === "install"),
    ),
    subscribe: stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(stateChanges);
        const latest = yield* Ref.get(updateStateRef);
        return { latest, changes: Stream.fromSubscription(subscription) };
      }),
    ),
    emitState,
    disabledReason: Effect.succeed(Option.none()),
    configure: Effect.gen(function* () {
      const settings = yield* desktopSettings.get;
      yield* setState(createSourceUpdateState(settings.updateChannel, environment));
      yield* Ref.set(updaterConfiguredRef, true);
      yield* logUpdaterInfo("using local source update mode", {
        repositoryPath: Option.getOrUndefined(localSourceUpdates.repositoryPath),
      });
      yield* startSourceSyncPoller;
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setChannel: Effect.fn("desktop.updates.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      const activeAction = yield* tryStartChannelChange;
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdates.DesktopUpdateActionInProgressError({
          action: activeAction.value === "install-recovery" ? "install" : activeAction.value,
          requestedChannel: nextChannel,
        });
      }

      // The channel is kept for when the app stops building from source; the
      // source updater always follows upstream nightlies.
      return yield* Effect.gen(function* () {
        const state = yield* Ref.get(updateStateRef);
        if (nextChannel === state.channel) {
          return state;
        }

        yield* desktopSettings.setUpdateChannel(nextChannel).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopUpdates.DesktopUpdateChannelPersistenceError({
                channel: nextChannel,
                cause,
              }),
          ),
        );

        yield* setState(createSourceUpdateState(nextChannel, environment));
        return yield* Ref.get(updateStateRef);
      }).pipe(Effect.ensuring(finishUpdateAction("channel")));
    }),
    check: Effect.fn("desktop.updates.check")(function* (reason: string) {
      yield* Effect.annotateCurrentSpan({ reason });
      if (!(yield* Ref.get(updaterConfiguredRef))) {
        return {
          checked: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const checked = yield* checkForUpdates(reason);
      return {
        checked,
        state: yield* Ref.get(updateStateRef),
      };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate;
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      } satisfies DesktopUpdateActionResult;
    }).pipe(Effect.withSpan("desktop.updates.download")),
    install: installWithExpectedVersion().pipe(
      Effect.map(({ accepted, completed, state }) => ({ accepted, completed, state })),
    ),
    installPrepared: (expectedVersion) => installWithExpectedVersion(expectedVersion),
  });
});

const pluralCommits = (count: number): string =>
  `${count} official commit${count === 1 ? "" : "s"}`;

function describeSourceSync(result: LocalSourceUpdates.LocalSourceSyncResult): string {
  if (result.merged === 0) return "Already includes everything from the official repository.";
  if (result.push === null || result.push.pushed) {
    return `Merged ${pluralCommits(result.merged)} and pushed the fork.`;
  }
  return `Merged ${pluralCommits(result.merged)}. The push to origin was skipped: ${result.push.reason}`;
}

/**
 * The "Sync fork with official T3 Code" action: merges upstream/main into the
 * checkout with the merge agent, pushes it to origin, then rechecks so the
 * update button offers the build.
 */
export const syncSource: Effect.Effect<
  DesktopSourceSyncResult,
  never,
  LocalSourceUpdates.LocalSourceUpdates | DesktopUpdates.DesktopUpdates
> = Effect.gen(function* () {
  const localSourceUpdates = yield* LocalSourceUpdates.LocalSourceUpdates;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  if (!(yield* localSourceUpdates.enabled)) {
    return {
      ok: false,
      merged: 0,
      message: "Syncing is only available in local source builds.",
    };
  }
  return yield* localSourceUpdates.syncSource.pipe(
    Effect.tap(() => updates.check("source-sync")),
    Effect.map(
      (result): DesktopSourceSyncResult => ({
        ok: true,
        merged: result.merged,
        message: describeSourceSync(result),
      }),
    ),
    Effect.catchTag("LocalSourceUpdateError", (error) =>
      logUpdaterError(error.message, { errorTag: error._tag, operation: error.operation }).pipe(
        Effect.as<DesktopSourceSyncResult>({ ok: false, merged: 0, message: error.message }),
      ),
    ),
  );
}).pipe(Effect.withSpan("desktop.updates.syncSource"));

/**
 * Provides DesktopUpdates, and the LocalSourceUpdates it decides with. Local
 * source builds get the source updater; every other build gets upstream's.
 */
export const layer = Layer.effect(
  DesktopUpdates.DesktopUpdates,
  Effect.gen(function* () {
    const localSourceUpdates = yield* LocalSourceUpdates.LocalSourceUpdates;
    return (yield* localSourceUpdates.enabled)
      ? yield* makeLocalSource
      : yield* DesktopUpdates.make;
  }),
).pipe(Layer.provideMerge(LocalSourceUpdates.layer));
