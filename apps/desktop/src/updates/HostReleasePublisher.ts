// Fork add-on: each time this app pushes the fork (a source sync or an update),
// the Mac app publishes a fork host release (`node scripts/tjn-hosts.ts release`)
// for that commit, and each fork host then updates itself through the
// maintenance queue. A newly installed build releases the checkout once more in
// case its commit was not released. The release runs detached so quitting the
// app does not stop it; its record, log and exit code live in stateDir. See
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
// Lets a relaunched app settle before the fallback release for its build.
const STARTUP_DELAY = "1 minute";
const WATCH_INTERVAL = "15 seconds";
// A recorded process this old without an exit code is a reused pid, not the release.
const RELEASE_MAX_MS = 6 * 60 * 60 * 1000;
// The exit code goes through a rename so a half-written file never reads as a result.
const RELEASE_SCRIPT = `node scripts/tjn-hosts.ts release --expect-sha "$1" > "$2" 2>&1
code=$?
printf '%s\\n' "$code" > "$3.tmp" && mv "$3.tmp" "$3"`;

const PublishRecord = Schema.fromJsonString(
  Schema.Struct({
    /** `<app version>@<commit hash>` of the installed build that started this run. */
    build: Schema.String,
    commit: Schema.String,
    pid: Schema.NullOr(Schema.Number),
    startedAt: Schema.Number,
    /** Set when the release was not started; the reason shown to the user. */
    refusal: Schema.NullOr(Schema.String),
  }),
);
type PublishRecord = typeof PublishRecord.Type;

// scripts/build-desktop-artifact.ts records the commit it built from.
const BuiltCommit = Schema.fromJsonString(
  Schema.Struct({ t3codeCommitHash: Schema.optionalKey(Schema.String) }),
);

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("host-release");

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
    /** Follows the fork pushes, and releases a newly installed build's checkout once. */
    readonly start: Effect.Effect<void>;
    /** Releases the checkout again, unless a release is running. */
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
  // The newest commit pushed while a release ran; it is released once that run ends.
  const queuedCommitRef = yield* Ref.make<string | null>(null);

  const repo = Option.getOrUndefined(localSourceUpdates.repositoryPath);
  const enabled = (yield* localSourceUpdates.enabled) && repo !== undefined;
  const recordPath = environment.path.join(environment.stateDir, RECORD_FILE);
  const logPath = environment.path.join(environment.stateDir, LOG_FILE);
  const exitPath = environment.path.join(environment.stateDir, EXIT_FILE);

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
    Effect.flatMap(Schema.decodeUnknownEffect(PublishRecord)),
    Effect.orElseSucceed(() => undefined),
  );
  const writeRecord = (record: PublishRecord) =>
    fileSystem
      .makeDirectory(environment.stateDir, { recursive: true })
      .pipe(
        Effect.andThen(
          fileSystem.writeFileString(recordPath, Schema.encodeSync(PublishRecord)(record)),
        ),
      );

  const statusOf = (record: PublishRecord) =>
    Effect.gen(function* () {
      const status = (
        state: DesktopHostReleaseStatus["state"],
        detail: string | null = null,
      ): DesktopHostReleaseStatus => ({
        state,
        commit: record.commit,
        startedAt: record.startedAt,
        detail,
        logPath,
      });
      if (record.refusal !== null) return status("failed", record.refusal);
      const code = yield* fileSystem.readFileString(exitPath).pipe(
        Effect.map((text) => text.trim()),
        Effect.option,
      );
      if (Option.isSome(code)) {
        if (code.value === "0") return status("succeeded");
        const log = yield* fileSystem.readFileString(logPath).pipe(Effect.orElseSucceed(() => ""));
        return status("failed", lastLine(log) ?? `The release exited with code ${code.value}.`);
      }
      const now = yield* Clock.currentTimeMillis;
      if (record.pid !== null && isAlive(record.pid) && now - record.startedAt < RELEASE_MAX_MS) {
        return status("running");
      }
      return status("failed", "The release stopped before it finished.");
    });

  const refresh = Effect.gen(function* () {
    const record = yield* readRecord;
    const next = record === undefined ? null : yield* statusOf(record);
    const previous = yield* Ref.getAndSet(lastStatusRef, next);
    if (next !== null && JSON.stringify(next) !== JSON.stringify(previous)) {
      yield* electronWindow.sendAll(IpcChannels.HOST_RELEASE_STATUS_CHANGE_CHANNEL, next);
      if (next.state === "failed") {
        yield* logWarning("host release failed", { detail: next.detail, logPath });
      } else if (next.state === "succeeded") {
        yield* logInfo("host release finished", { commit: next.commit });
      }
    }
    return next;
  });

  const gitOutput = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      spawner
        .spawn(
          ChildProcess.make("git", args, {
            cwd: repo,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
          }),
        )
        .pipe(
          Effect.flatMap((child) =>
            Effect.all([child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode], {
              concurrency: "unbounded",
            }),
          ),
        ),
    ).pipe(
      Effect.map(([stdout, code]) => (Number(code) === 0 ? stdout.trim() : undefined)),
      Effect.orElseSucceed(() => undefined),
    );

  const launch = (commit: string | undefined) =>
    Effect.gen(function* () {
      if (!enabled || build === undefined || repo === undefined) return;
      const startedAt = yield* Clock.currentTimeMillis;
      if (commit === undefined) {
        return yield* writeRecord({
          build,
          commit: "",
          pid: null,
          startedAt,
          refusal: "The source checkout has no commit to release.",
        });
      }
      yield* fileSystem.remove(exitPath, { force: true });
      const pid = yield* Effect.scoped(
        spawner
          .spawn(
            ChildProcess.make("/bin/sh", ["-c", RELEASE_SCRIPT, "sh", commit, logPath, exitPath], {
              cwd: repo,
              env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              detached: true,
            }),
          )
          .pipe(
            Effect.tap((child) => child.unref),
            Effect.map((child) => Number(child.pid)),
          ),
      ).pipe(Effect.option);
      yield* writeRecord(
        Option.isNone(pid)
          ? {
              build,
              commit,
              pid: null,
              startedAt,
              refusal: "The release tool could not be started.",
            }
          : { build, commit, pid: pid.value, startedAt, refusal: null },
      );
      if (Option.isSome(pid)) yield* logInfo("host release started", { commit, logPath });
    }).pipe(
      Effect.catchCause((cause) =>
        logWarning("host release could not start", { cause: Cause.pretty(cause) }),
      ),
    );

  // Runs while a release is running, then releases a commit pushed meanwhile.
  const watch: Effect.Effect<void> = Effect.gen(function* () {
    while ((yield* refresh)?.state === "running") yield* Effect.sleep(WATCH_INTERVAL);
    const queued = yield* Ref.getAndSet(queuedCommitRef, null);
    const record = yield* readRecord;
    if (queued === null || queued === record?.commit) return;
    yield* launch(queued);
    yield* watch;
  });

  /** A release that ran or runs for this commit needs no other. */
  const releasedOrRunning = (commit: string) =>
    Effect.gen(function* () {
      const record = yield* readRecord;
      if (record === undefined || record.commit !== commit) return false;
      return (yield* statusOf(record)).state !== "failed";
    });

  const releasePushed = (commit: string) =>
    Effect.gen(function* () {
      if ((yield* refresh)?.state === "running") {
        yield* Ref.set(queuedCommitRef, commit);
        return;
      }
      if (yield* releasedOrRunning(commit)) return;
      yield* launch(commit);
      yield* watch.pipe(Effect.forkIn(scope));
    });

  const start = Effect.gen(function* () {
    if (!enabled || build === undefined) return;
    yield* localSourceUpdates.pushedCommits.pipe(
      Stream.runForEach(releasePushed),
      Effect.forkIn(scope),
    );
    const record = yield* readRecord;
    if (record?.build !== build) {
      yield* Effect.sleep(STARTUP_DELAY);
      const head = yield* gitOutput(["rev-parse", "HEAD"]);
      const current = yield* readRecord;
      if (head !== undefined && (yield* releasedOrRunning(head)) && current !== undefined) {
        yield* writeRecord({ ...current, build }).pipe(Effect.ignore);
      } else if ((yield* refresh)?.state !== "running") {
        yield* launch(head);
      }
    }
    yield* watch;
  }).pipe(Effect.forkIn(scope), Effect.asVoid, Effect.withSpan("desktop.hostRelease.start"));

  const retry = Effect.gen(function* () {
    const status = yield* refresh;
    if (status?.state === "running") return status;
    yield* launch(yield* gitOutput(["rev-parse", "HEAD"]));
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
