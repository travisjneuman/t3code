// Fork add-on: only the explicit Update flow emits buildCommits. The Mac app asks
// each configured host to build and stage that commit locally, then advertises
// the returned target to its clients. Source sync only pulls host checkouts. A
// detached run survives quitting the app; its record, log and exit code live in
// stateDir. See
// docs/operations/fork-host-releases.md.
import type { DesktopHostReleaseStatus } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../fork/channels.ts";
import * as LocalSourceUpdates from "./LocalSourceUpdates.ts";

const RECORD_FILE = "host-release.json";
const LOG_FILE = "host-release.log";
const EXIT_FILE = "host-release.exit";
const RESULT_FILE = "host-fleet-build-result.json";
const WATCH_INTERVAL = "15 seconds";
// A recorded process this old without an exit code is a reused pid, not the build.
const BUILD_MAX_MS = 6 * 60 * 60 * 1000;
// The exit code goes through a rename so a half-written file never reads as a result.
const BUILD_SCRIPT = `node scripts/tjn-hosts.ts build-local --expect-sha "$1" --result-file "$2" > "$3" 2>&1
code=$?
printf '%s\\n' "$code" > "$4.tmp" && mv "$4.tmp" "$4"`;

const BuildRecord = Schema.fromJsonString(
  Schema.Struct({
    /** `<app version>@<commit hash>` of the installed build that started this run. */
    build: Schema.String,
    commit: Schema.String,
    pid: Schema.NullOr(Schema.Number),
    startedAt: Schema.Number,
    /** Old desktop records omit this, but new runs are always local staging builds. */
    operation: Schema.optionalKey(Schema.Literal("build-local")),
    /** Set when the build was not started; the reason shown to the user. */
    refusal: Schema.NullOr(Schema.String),
  }),
);
type BuildRecord = typeof BuildRecord.Type;

const BuildResult = Schema.fromJsonString(
  Schema.Struct({ commit: Schema.String, targetVersion: Schema.String }),
);

// scripts/build-desktop-artifact.ts records the commit it built from.
const BuiltCommit = Schema.fromJsonString(
  Schema.Struct({ t3codeCommitHash: Schema.optionalKey(Schema.String) }),
);

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("host-fleet-build");

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const lastLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line !== "");

export class HostReleasePublisher extends Context.Service<
  HostReleasePublisher,
  {
    readonly getStatus: Effect.Effect<DesktopHostReleaseStatus | null>;
    /** Starts only for a commit emitted by Update; startup only observes existing state. */
    readonly start: Effect.Effect<void>;
    /** Retries the existing failed user-triggered build at its recorded commit. */
    readonly retry: Effect.Effect<DesktopHostReleaseStatus | null>;
  }
>()("t3/desktop/updates/HostReleasePublisher") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const localSourceUpdates = yield* LocalSourceUpdates.LocalSourceUpdates;
  const scope = yield* Scope.Scope;
  const lastStatusRef = yield* Ref.make<DesktopHostReleaseStatus | null>(null);
  // The newest commit explicitly requested while a local host build runs; stage it when that run ends.
  const queuedCommitRef = yield* Ref.make<string | null>(null);

  const repo = Option.getOrUndefined(localSourceUpdates.repositoryPath);
  const enabled = (yield* localSourceUpdates.enabled) && repo !== undefined;
  const recordPath = environment.path.join(environment.stateDir, RECORD_FILE);
  const logPath = environment.path.join(environment.stateDir, LOG_FILE);
  const exitPath = environment.path.join(environment.stateDir, EXIT_FILE);
  // Matches the host script's default result path so an explicit build remains observable
  // across the Mac app's automatic install/relaunch.
  const resultPath = environment.path.join(
    environment.homeDirectory,
    "Library",
    "Application Support",
    "t3code-fork",
    RESULT_FILE,
  );

  const commitHash = yield* fileSystem
    .readFileString(environment.path.join(environment.appPath, "package.json"))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(BuiltCommit)),
      Effect.map((json) => json.t3codeCommitHash?.trim().toLowerCase()),
      Effect.orElseSucceed(() => undefined),
    );
  const build =
    commitHash !== undefined && /^[0-9a-f]{7,40}$/u.test(commitHash)
      ? `${environment.appVersion}@${commitHash}`
      : undefined;

  const readRecord = fileSystem.readFileString(recordPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(BuildRecord)),
    Effect.orElseSucceed(() => undefined),
  );
  const writeRecord = (record: BuildRecord) => {
    const tempPath = `${recordPath}.tmp`;
    return fileSystem.makeDirectory(environment.stateDir, { recursive: true }).pipe(
      Effect.andThen(
        fileSystem.writeFileString(tempPath, Schema.encodeSync(BuildRecord)(record)),
      ),
      Effect.andThen(fileSystem.rename(tempPath, recordPath)),
    );
  };

  const statusOf = (record: BuildRecord) =>
    Effect.gen(function* () {
      const status = (
        state: DesktopHostReleaseStatus["state"],
        detail: string | null = null,
        targetVersion?: string,
      ): DesktopHostReleaseStatus => ({
        state,
        commit: record.commit,
        startedAt: record.startedAt,
        detail,
        logPath,
        ...(state === "succeeded" && targetVersion !== undefined ? { targetVersion } : {}),
      });
      if (record.operation !== "build-local") {
        const now = yield* Clock.currentTimeMillis;
        if (record.pid !== null && isAlive(record.pid) && now - record.startedAt < BUILD_MAX_MS) {
          return status("running");
        }
        return status(
          "failed",
          record.commit.length > 0
            ? "Legacy fleet update retired; Retry builds this commit locally with the new workflow."
            : "Legacy fleet update retired; press Update to build the current commit locally.",
        );
      }
      if (record.refusal !== null) return status("failed", record.refusal);
      const code = yield* fileSystem.readFileString(exitPath).pipe(
        Effect.map((text) => text.trim()),
        Effect.option,
      );
      if (Option.isSome(code)) {
        if (code.value === "0") {
          const result = yield* fileSystem.readFileString(resultPath).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(BuildResult)),
            Effect.option,
          );
          const targetSuffix = `+${record.commit.slice(0, 12)}`;
          if (
            Option.isSome(result) &&
            /^[0-9a-f]{40}$/u.test(record.commit) &&
            result.value.commit === record.commit &&
            result.value.targetVersion.trim() !== "" &&
            result.value.targetVersion.endsWith(targetSuffix)
          ) {
            return status("succeeded", null, result.value.targetVersion);
          }
          return status("failed", "The staged target did not match the requested commit.");
        }
        const log = yield* fileSystem.readFileString(logPath).pipe(Effect.orElseSucceed(() => ""));
        return status("failed", lastLine(log) ?? `The host build exited with code ${code.value}.`);
      }
      const now = yield* Clock.currentTimeMillis;
      if (
        now - record.startedAt < BUILD_MAX_MS &&
        (record.pid === null || isAlive(record.pid))
      ) {
        return status("running");
      }
      return status("failed", "The host build stopped before it finished.");
    });

  // `quietEnd` leaves a finished run unannounced, for when a newer commit may replace it.
  const announce = (quietEnd: boolean) =>
    Effect.gen(function* () {
      const record = yield* readRecord;
      const next = record === undefined ? null : yield* statusOf(record);
      if (quietEnd && next !== null && next.state !== "running") return next;
      const previous = yield* Ref.getAndSet(lastStatusRef, next);
      if (next !== null && JSON.stringify(next) !== JSON.stringify(previous)) {
        yield* electronWindow.sendAll(IpcChannels.HOST_RELEASE_STATUS_CHANGE_CHANNEL, next);
        if (next.state === "failed") {
          yield* logWarning("local host build failed", { detail: next.detail, logPath });
        } else if (next.state === "succeeded") {
          yield* logInfo("local host build finished", {
            commit: next.commit,
            targetVersion: next.targetVersion,
          });
        }
      }
      return next;
    });
  const refresh = announce(false);

  const launch = (commit: string) =>
    Effect.gen(function* () {
      if (!enabled || build === undefined || repo === undefined) return;
      const startedAt = yield* Clock.currentTimeMillis;
      yield* fileSystem.remove(resultPath, { force: true });
      yield* fileSystem.remove(exitPath, { force: true });
      const pendingRecord: BuildRecord = {
        build,
        commit,
        pid: null,
        startedAt,
        operation: "build-local",
        refusal: null,
      };
      // Persist identity before spawning so a crash cannot pair an old record with this run's result.
      yield* writeRecord(pendingRecord);
      const pid = yield* Effect.scoped(
        spawner
          .spawn(
            ChildProcess.make(
              "/bin/sh",
              ["-c", BUILD_SCRIPT, "sh", commit, resultPath, logPath, exitPath],
              {
                cwd: repo,
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
                detached: true,
              },
            ),
          )
          .pipe(
            Effect.tap((child) => child.unref),
            Effect.map((child) => Number(child.pid)),
          ),
      ).pipe(Effect.option);
      yield* writeRecord(
        Option.isNone(pid)
          ? { ...pendingRecord, refusal: "The host build tool could not be started." }
          : { ...pendingRecord, pid: pid.value },
      );
      if (Option.isSome(pid)) yield* logInfo("local host build started", { commit, logPath });
    }).pipe(
      Effect.catchCause((cause) =>
        logWarning("local host build could not start", { cause: Cause.pretty(cause) }),
      ),
    );

  // Runs while a host build is running, then stages a newer commit only if Update requested it.
  const watch: Effect.Effect<void> = Effect.gen(function* () {
    while ((yield* announce(true))?.state === "running") yield* Effect.sleep(WATCH_INTERVAL);
    const queued = yield* Ref.getAndSet(queuedCommitRef, null);
    const record = yield* readRecord;
    if (queued === null || queued === record?.commit) {
      yield* refresh;
      return;
    }
    yield* launch(queued);
    yield* watch;
  });

  /** A local build that succeeded or runs for this commit needs no other. */
  const builtOrBuilding = (commit: string) =>
    Effect.gen(function* () {
      const record = yield* readRecord;
      if (record === undefined || record.commit !== commit) return false;
      return (yield* statusOf(record)).state !== "failed";
    });

  const buildRequested = (commit: string) =>
    Effect.gen(function* () {
      if ((yield* refresh)?.state === "running") {
        yield* Ref.set(queuedCommitRef, commit);
        return;
      }
      if (yield* builtOrBuilding(commit)) return;
      yield* launch(commit);
      yield* watch.pipe(Effect.forkIn(scope));
    });

  const start = Effect.gen(function* () {
    if (!enabled || build === undefined) return;
    yield* localSourceUpdates.buildCommits.pipe(
      Stream.runForEach(buildRequested),
      Effect.forkIn(scope),
    );
    // Starting the app only observes a run left by an explicit Update; it never stages HEAD.
    yield* watch;
  }).pipe(Effect.forkIn(scope), Effect.asVoid, Effect.withSpan("desktop.hostRelease.start"));

  const retry = Effect.gen(function* () {
    const status = yield* refresh;
    if (status?.state === "running") return status;
    const record = yield* readRecord;
    if (status?.state !== "failed" || record === undefined || record.commit.length === 0) return status;
    yield* launch(record.commit);
    yield* watch.pipe(Effect.forkIn(scope));
    return yield* refresh;
  }).pipe(Effect.withSpan("desktop.hostRelease.retry"));

  return HostReleasePublisher.of({
    getStatus: enabled ? refresh : Effect.succeed(null),
    start,
    retry: enabled ? retry : Effect.succeed(null),
  });
});

export const layer = Layer.effect(HostReleasePublisher, make);
