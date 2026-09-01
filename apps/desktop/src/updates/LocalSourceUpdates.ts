import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const COMMAND_OUTPUT_LIMIT = 16_000;
const LOCAL_UPDATE_HELPER_PATH = "local-source-update-helper.sh";

const LocalSourceUpdateOperation = Schema.Literals([
  "configuration",
  "inspect",
  "fetch",
  "merge",
  "push",
  "build",
  "install",
]);
type LocalSourceUpdateOperation = typeof LocalSourceUpdateOperation.Type;

export class LocalSourceUpdateError extends Schema.TaggedErrorClass<LocalSourceUpdateError>()(
  "LocalSourceUpdateError",
  {
    operation: LocalSourceUpdateOperation,
    repositoryPath: Schema.String,
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Local source update ${this.operation} failed for ${this.repositoryPath}: ${this.detail}`;
  }
}

export interface LocalSourceUpdateInspection {
  readonly repositoryPath: string;
  readonly currentCommit: string;
  readonly upstreamCommit: string;
  readonly ahead: number;
  readonly behind: number;
}

export interface LocalSourceUpdateBuild {
  readonly version: string;
  readonly applicationBundlePath: string;
}

export class LocalSourceUpdates extends Context.Service<
  LocalSourceUpdates,
  {
    readonly enabled: Effect.Effect<boolean>;
    readonly inspect: Effect.Effect<LocalSourceUpdateInspection, LocalSourceUpdateError>;
    readonly syncAndBuild: Effect.Effect<LocalSourceUpdateBuild, LocalSourceUpdateError>;
    readonly install: Effect.Effect<void, LocalSourceUpdateError>;
  }
>()("@t3tools/desktop/updates/LocalSourceUpdates") {}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const LOCAL_UPDATE_HELPER = `#!/bin/sh
set -eu

source_app="$1"
target_app="$2"
parent_pid="$3"
backup_app="\${target_app}.previous-\${parent_pid}"

while kill -0 "$parent_pid" 2>/dev/null; do
  sleep 0.25
done

if [ ! -d "$source_app" ]; then
  exit 1
fi

if [ -e "$target_app" ]; then
  mv "$target_app" "$backup_app"
fi

if mv "$source_app" "$target_app"; then
  /usr/bin/open "$target_app"
  exit 0
fi

if [ -e "$backup_app" ]; then
  mv "$backup_app" "$target_app" || true
fi
exit 1
`;

function tailOutput(value: string): string {
  return value.length <= COMMAND_OUTPUT_LIMIT ? value : value.slice(-COMMAND_OUTPUT_LIMIT);
}

function trimOutput(result: CommandResult): string {
  return tailOutput(`${result.stderr}\n${result.stdout}`.trim());
}

function parseCountPair(output: string): readonly [number, number] | null {
  const values = output.trim().split(/\s+/u).map(Number);
  if (values.length !== 2 || values.some((value) => !Number.isInteger(value) || value < 0)) {
    return null;
  }
  return [values[0]!, values[1]!];
}

function normalizeRemoteUrl(value: string): string {
  return value
    .trim()
    .replace(/\.git$/u, "")
    .replace(/^https?:\/\/github\.com\//u, "")
    .replace(/^git@github\.com:/u, "")
    .replace(/^ssh:\/\/git@github\.com\//u, "")
    .replace(/\/+$/u, "")
    .toLowerCase();
}

export function resolveMacApplicationBundlePath(
  executablePath: string,
  resolvePath: (path: string, ...segments: ReadonlyArray<string>) => string,
  dirname: (path: string) => string,
): string {
  return resolvePath(dirname(executablePath), "..", "..");
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const builtUpdateRef = yield* Ref.make<LocalSourceUpdateBuild | null>(null);
  const repositoryPath = environment.sourceRepositoryPath;

  const makeError = (
    operation: LocalSourceUpdateOperation,
    detail: string,
    cause: unknown = new Error(detail),
    path = repositoryPath ?? "(not configured)",
  ) => new LocalSourceUpdateError({ operation, repositoryPath: path, detail, cause });

  const requireRepositoryPath = Effect.gen(function* () {
    if (environment.platform !== "darwin" || !environment.isPackaged) {
      return yield* makeError(
        "configuration",
        "local source updates are only supported by packaged macOS builds",
      );
    }
    if (!repositoryPath) {
      return yield* makeError("configuration", "no source repository is configured");
    }
    const stat = yield* fileSystem.stat(repositoryPath).pipe(Effect.option);
    if (stat._tag === "None" || stat.value.type !== "Directory") {
      return yield* makeError("configuration", "the source repository is not a directory");
    }
    return repositoryPath;
  });

  const runCommand = Effect.fn("desktop.localSourceUpdates.runCommand")(function* (input: {
    readonly operation: LocalSourceUpdateOperation;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
  }): Effect.fn.Return<CommandResult, LocalSourceUpdateError> {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(input.command, input.args, {
            cwd: input.cwd,
            env: {
              ...process.env,
              GIT_TERMINAL_PROMPT: "0",
              GCM_INTERACTIVE: "Never",
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
            forceKillAfter: "2 seconds",
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (all, chunk) => tailOutput(all + chunk),
              ),
            ),
            handle.stderr.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (all, chunk) => tailOutput(all + chunk),
              ),
            ),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, exitCode: Number(exitCode) } satisfies CommandResult;
      }),
    ).pipe(
      Effect.mapError((cause) =>
        makeError(input.operation, "could not start or read the command", cause, input.cwd),
      ),
    );
  });

  const runChecked = Effect.fn("desktop.localSourceUpdates.runChecked")(function* (input: {
    readonly operation: LocalSourceUpdateOperation;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
  }) {
    const result = yield* runCommand(input);
    if (result.exitCode !== 0) {
      const output = trimOutput(result);
      return yield* makeError(
        input.operation,
        `command exited with code ${result.exitCode}${output ? `: ${output}` : ""}`,
        new Error(output),
        input.cwd,
      );
    }
    return result;
  });

  const inspect = Effect.gen(function* () {
    const repo = yield* requireRepositoryPath;
    const git = (operation: LocalSourceUpdateOperation, args: ReadonlyArray<string>) =>
      runCommand({ operation, command: "git", args, cwd: repo });
    const gitChecked = (operation: LocalSourceUpdateOperation, args: ReadonlyArray<string>) =>
      runChecked({ operation, command: "git", args, cwd: repo });

    const root = yield* gitChecked("inspect", ["rev-parse", "--show-toplevel"]);
    if (root.stdout.trim() !== repo) {
      return yield* makeError(
        "inspect",
        `git resolved a different checkout at ${root.stdout.trim()}`,
        new Error("checkout root mismatch"),
        repo,
      );
    }
    const branch = yield* gitChecked("inspect", ["branch", "--show-current"]);
    if (branch.stdout.trim() !== "main") {
      return yield* makeError(
        "inspect",
        `checkout is on ${branch.stdout.trim() || "detached HEAD"}; expected main`,
        new Error("branch mismatch"),
        repo,
      );
    }
    const mergeHead = yield* git("inspect", ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if (mergeHead.exitCode === 0) {
      return yield* makeError(
        "inspect",
        "a merge is already in progress",
        new Error("merge in progress"),
        repo,
      );
    }
    const status = yield* gitChecked("inspect", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status.stdout.trim().length > 0) {
      return yield* makeError(
        "inspect",
        `checkout has local changes:\n${tailOutput(status.stdout.trim())}`,
        new Error("dirty checkout"),
        repo,
      );
    }
    const origin = yield* gitChecked("inspect", ["config", "--get", "remote.origin.url"]);
    if (normalizeRemoteUrl(origin.stdout) !== "travisjneuman/t3code") {
      return yield* makeError(
        "inspect",
        `origin is ${origin.stdout.trim()}; expected travisjneuman/t3code`,
        new Error("origin mismatch"),
        repo,
      );
    }
    const upstream = yield* gitChecked("inspect", ["config", "--get", "remote.upstream.url"]);
    if (normalizeRemoteUrl(upstream.stdout) !== "pingdotgg/t3code") {
      return yield* makeError(
        "inspect",
        `upstream is ${upstream.stdout.trim()}; expected pingdotgg/t3code`,
        new Error("upstream mismatch"),
        repo,
      );
    }
    yield* gitChecked("fetch", ["fetch", "--prune", "upstream", "main"]);
    const counts = yield* gitChecked("inspect", [
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...upstream/main",
    ]);
    const countPair = parseCountPair(counts.stdout);
    if (!countPair) {
      return yield* makeError(
        "inspect",
        `could not parse upstream divergence: ${counts.stdout.trim()}`,
        new Error("invalid rev-list output"),
        repo,
      );
    }
    const currentCommit = yield* gitChecked("inspect", ["rev-parse", "HEAD"]);
    const upstreamCommit = yield* gitChecked("inspect", ["rev-parse", "upstream/main"]);
    return {
      repositoryPath: repo,
      currentCommit: currentCommit.stdout.trim(),
      upstreamCommit: upstreamCommit.stdout.trim(),
      ahead: countPair[0],
      behind: countPair[1],
    } satisfies LocalSourceUpdateInspection;
  }).pipe(Effect.withSpan("desktop.localSourceUpdates.inspect"));

  const findAppBundle = Effect.fn("desktop.localSourceUpdates.findAppBundle")(function* (
    root: string,
  ): Effect.fn.Return<string, LocalSourceUpdateError> {
    const entries = yield* fileSystem
      .readDirectory(root)
      .pipe(
        Effect.mapError((cause) =>
          makeError("build", `could not read build output ${root}`, cause),
        ),
      );
    for (const entry of entries) {
      const entryPath = environment.path.join(root, entry);
      const stat = yield* fileSystem.stat(entryPath).pipe(Effect.option);
      if (stat._tag === "Some" && stat.value.type === "Directory" && entry.endsWith(".app")) {
        return entryPath;
      }
      if (stat._tag === "Some" && stat.value.type === "Directory") {
        const nested = yield* findAppBundle(entryPath).pipe(Effect.option);
        if (nested._tag === "Some") return nested.value;
      }
    }
    return yield* makeError("build", `no macOS application bundle was produced under ${root}`);
  });

  const syncAndBuild = Effect.gen(function* () {
    const inspection = yield* inspect;
    if (inspection.behind === 0) {
      const pendingBuild = yield* Ref.get(builtUpdateRef);
      if (pendingBuild) {
        yield* runChecked({
          operation: "push",
          command: "git",
          args: ["push", "origin", "HEAD:main"],
          cwd: inspection.repositoryPath,
        });
        return pendingBuild;
      }
      return yield* makeError(
        "merge",
        "the fork is already current with upstream/main",
        new Error("no upstream commits"),
        inspection.repositoryPath,
      );
    }
    const merge = yield* runCommand({
      operation: "merge",
      command: "git",
      args: ["merge", "--no-edit", "--no-ff", "upstream/main"],
      cwd: inspection.repositoryPath,
    });
    if (merge.exitCode !== 0) {
      yield* runCommand({
        operation: "merge",
        command: "git",
        args: ["merge", "--abort"],
        cwd: inspection.repositoryPath,
      }).pipe(Effect.ignore);
      const output = trimOutput(merge);
      return yield* makeError(
        "merge",
        `upstream merge failed${output ? `: ${output}` : ""}`,
        new Error(output),
        inspection.repositoryPath,
      );
    }
    const built = yield* Effect.gen(function* () {
      const timestamp = yield* Clock.currentTimeMillis;
      const outputDir = environment.path.join(
        environment.stateDir,
        "source-updates",
        `${timestamp}-${process.pid}`,
      );
      yield* fileSystem
        .makeDirectory(outputDir, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            makeError(
              "build",
              `could not create local build output ${outputDir}`,
              cause,
              inspection.repositoryPath,
            ),
          ),
        );
      const arch = environment.runtimeInfo.appArch;
      if (arch !== "arm64" && arch !== "x64") {
        return yield* makeError(
          "build",
          `unsupported desktop architecture ${arch}`,
          new Error("unsupported architecture"),
          inspection.repositoryPath,
        );
      }
      yield* runChecked({
        operation: "build",
        command: "vp",
        args: [
          "run",
          "dist:desktop:artifact",
          "--platform",
          "mac",
          "--target",
          "dir",
          "--arch",
          arch,
          "--build-version",
          environment.appVersion,
          "--output-dir",
          outputDir,
        ],
        cwd: inspection.repositoryPath,
      });
      const applicationBundlePath = yield* findAppBundle(outputDir);
      return { applicationBundlePath };
    }).pipe(
      Effect.catchCause((cause) =>
        runCommand({
          operation: "merge",
          command: "git",
          args: ["merge", "--abort"],
          cwd: inspection.repositoryPath,
        }).pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause))),
      ),
    );
    const build = {
      version: inspection.upstreamCommit,
      applicationBundlePath: built.applicationBundlePath,
    } satisfies LocalSourceUpdateBuild;
    yield* Ref.set(builtUpdateRef, build);
    yield* runChecked({
      operation: "push",
      command: "git",
      args: ["push", "origin", "HEAD:main"],
      cwd: inspection.repositoryPath,
    });
    return build;
  }).pipe(Effect.withSpan("desktop.localSourceUpdates.syncAndBuild"));

  const install = Effect.gen(function* () {
    const builtUpdate = yield* Ref.get(builtUpdateRef);
    if (!builtUpdate) {
      return yield* makeError("install", "no locally built application is waiting to be installed");
    }
    const sourceApp = builtUpdate.applicationBundlePath;
    const targetApp = resolveMacApplicationBundlePath(
      process.execPath,
      environment.path.resolve,
      environment.path.dirname,
    );
    const helperPath = environment.path.join(environment.stateDir, LOCAL_UPDATE_HELPER_PATH);
    yield* fileSystem
      .makeDirectory(environment.stateDir, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          makeError("install", "could not prepare the local update state directory", cause),
        ),
      );
    yield* fileSystem
      .writeFileString(helperPath, LOCAL_UPDATE_HELPER)
      .pipe(
        Effect.mapError((cause) =>
          makeError("install", "could not write the local replacement helper", cause),
        ),
      );
    yield* Effect.scoped(
      spawner
        .spawn(
          ChildProcess.make("/bin/sh", [helperPath, sourceApp, targetApp, String(process.pid)], {
            cwd: environment.stateDir,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            detached: true,
          }),
        )
        .pipe(
          Effect.flatMap((child) => child.unref),
          Effect.asVoid,
        ),
    ).pipe(
      Effect.mapError((cause) =>
        makeError("install", "could not start the local replacement helper", cause),
      ),
    );
  }).pipe(Effect.withSpan("desktop.localSourceUpdates.install"));

  return LocalSourceUpdates.of({
    enabled: Effect.succeed(
      environment.platform === "darwin" && environment.isPackaged && repositoryPath !== undefined,
    ),
    inspect,
    syncAndBuild,
    install,
  });
});

export const layer = Layer.effect(LocalSourceUpdates, make);
