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
import { resolveRenameOnlyConflict, resolveRenameOnlyHunks } from "./forkMergeResolution.ts";

const COMMAND_OUTPUT_LIMIT = 16_000;
const LOCAL_UPDATE_HELPER_PATH = "local-source-update-helper.sh";
// Holds at most one build: cleared before each build, after a failed build, and by the install helper.
const SOURCE_UPDATE_BUILDS_DIR = "source-updates";
const LOCKFILE_PATH = "pnpm-lock.yaml";
const MERGE_AGENT_TIMEOUT = "20 minutes";
const CONFLICT_MARKER_PATTERN = /^(?:<{7}|>{7})(?: |$)/mu;
const MERGE_AGENT_RULES = [
  "You are finishing a merge of the upstream T3 Code nightly (pingdotgg/t3code) into the ndev.t3code fork.",
  "The fork is an add-on: keep every upstream change and every fork addition.",
  "Never drop fork features (the ChatGPT, Claude, Grok, and Gemini remote app tabs, the local source updater, the ndev.t3code branding) and never revert upstream changes.",
  "Where upstream renamed or reshaped code the fork uses, adapt the fork code to the new upstream shape.",
  'Product text stays "ndev.t3code". Change only what the task needs.',
].join(" ");
const NIGHTLY_TAG_GLOB = "v*-nightly.*";
const NIGHTLY_TAG_PATTERN = /^v\d+\.\d+\.\d+-nightly\.\d+\.\d+$/u;
const UNRESOLVED_PATH_LIST_LIMIT = 10;
const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

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

export class LocalSourceUpdateError extends Schema.TaggedError<LocalSourceUpdateError>()(
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
  /** Newest upstream nightly tag reachable from upstream/main, e.g. `v0.0.46-nightly.20261003.2610`. */
  readonly upstreamTag: string;
  /** The tag without its leading `v`; used as the local build version. */
  readonly upstreamVersion: string;
  /** Commit the nightly tag points at. */
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
builds_dir="$4"
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
  # Keep exactly one installed app and no leftover build output.
  rm -rf "$backup_app" "$builds_dir"
  /usr/bin/open "$target_app"
  exit 0
fi

if [ -e "$backup_app" ]; then
  mv "$backup_app" "$target_app" || true
fi
exit 1
`;

function tailOutput(value: string, limit = COMMAND_OUTPUT_LIMIT): string {
  return value.length <= limit ? value : value.slice(-limit);
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

/**
 * Picks the newest nightly tag from `git tag --list --sort=v:refname` output
 * (ascending, so the newest is last and survives output tail truncation).
 */
export function selectNewestNightlyTag(output: string): string | null {
  const tags = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => NIGHTLY_TAG_PATTERN.test(line));
  return tags.at(-1) ?? null;
}

export const nightlyVersionFromTag = (tag: string): string => tag.replace(/^v/u, "");

export interface UnmergedPath {
  readonly path: string;
  /** Index stage (1 base, 2 ours, 3 theirs) to file mode. A missing stage was deleted on that side. */
  readonly stages: ReadonlyMap<number, string>;
}

/** Parses `git ls-files -u -z` records: `<mode> <object> <stage>\t<path>\0`. */
export function parseUnmergedPaths(output: string): ReadonlyArray<UnmergedPath> {
  const byPath = new Map<string, Map<number, string>>();
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, , stageText] = record.slice(0, tab).split(" ");
    const stage = Number(stageText);
    if (!mode || (stage !== 1 && stage !== 2 && stage !== 3)) continue;
    const path = record.slice(tab + 1);
    const stages = byPath.get(path) ?? new Map<number, string>();
    stages.set(stage, mode);
    byPath.set(path, stages);
  }
  return Array.from(byPath, ([path, stages]) => ({ path, stages }));
}

// Only plain text files whose mode both sides agree on are rewritten; links,
// submodules, and mode changes are left for a human.
const isRewritableConflict = (entry: UnmergedPath): boolean => {
  const modes = Array.from(entry.stages.values());
  const ours = entry.stages.get(2);
  const theirs = entry.stages.get(3);
  return (
    modes.every((mode) => REGULAR_FILE_MODES.has(mode)) &&
    (ours === undefined || theirs === undefined || ours === theirs)
  );
};

const isBinaryText = (value: string | null): boolean => value !== null && value.includes("\u0000");

function describeUnresolvedPaths(paths: ReadonlyArray<string>): string {
  const listed = paths.slice(0, UNRESOLVED_PATH_LIST_LIMIT).join(", ");
  const rest = paths.length - UNRESOLVED_PATH_LIST_LIMIT;
  return rest > 0 ? `${listed}, and ${rest} more` : listed;
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
    /** Characters of stdout/stderr kept (from the end). File reads pass Infinity. */
    readonly outputLimit?: number;
  }): Effect.fn.Return<CommandResult, LocalSourceUpdateError> {
    const outputLimit = input.outputLimit ?? COMMAND_OUTPUT_LIMIT;
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
                (all, chunk) => tailOutput(all + chunk, outputLimit),
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
    readonly outputLimit?: number;
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
    // --tags brings upstream's nightly tags along with main. Tags fetched
    // through --tags are not subject to --prune, so fork-local tags survive,
    // and a tag that would move is refused rather than clobbered.
    yield* gitChecked("fetch", ["fetch", "--prune", "--tags", "upstream", "main"]);
    // Nightly tags encode version, date, and run number, so version order is
    // release order. Creator date is not: lightweight tags report the commit
    // date, and a re-tagged run can sort out of order. --merged keeps tags
    // that upstream/main actually contains.
    const tagList = yield* gitChecked("inspect", [
      "tag",
      "--list",
      NIGHTLY_TAG_GLOB,
      "--merged",
      "upstream/main",
      "--sort=v:refname",
    ]);
    const upstreamTag = selectNewestNightlyTag(tagList.stdout);
    if (!upstreamTag) {
      return yield* makeError(
        "inspect",
        "no upstream nightly tag is reachable from upstream/main",
        new Error("no nightly tag"),
        repo,
      );
    }
    const upstreamCommit = yield* gitChecked("inspect", [
      "rev-parse",
      "--verify",
      `refs/tags/${upstreamTag}^{commit}`,
    ]);
    const counts = yield* gitChecked("inspect", [
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...${upstreamCommit.stdout.trim()}`,
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
    return {
      repositoryPath: repo,
      currentCommit: currentCommit.stdout.trim(),
      upstreamTag,
      upstreamVersion: nightlyVersionFromTag(upstreamTag),
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

  const listUnmergedPaths = (repo: string) =>
    runChecked({
      operation: "merge",
      command: "git",
      args: ["ls-files", "--unmerged", "-z"],
      cwd: repo,
      outputLimit: Number.POSITIVE_INFINITY,
    }).pipe(Effect.map((result) => parseUnmergedPaths(result.stdout)));

  // A stage missing from the index means the file was deleted on that side.
  const readStage = (repo: string, entry: UnmergedPath, stage: 1 | 2 | 3) =>
    entry.stages.has(stage)
      ? runChecked({
          operation: "merge",
          command: "git",
          args: ["show", `:${stage}:${entry.path}`],
          cwd: repo,
          outputLimit: Number.POSITIVE_INFINITY,
        }).pipe(Effect.map((result): string | null => result.stdout))
      : Effect.succeed<string | null>(null);

  const writeWorkingFile = (repo: string, path: string, contents: string) =>
    fileSystem
      .writeFileString(environment.path.join(repo, path), contents)
      .pipe(Effect.mapError((cause) => makeError("merge", `could not write ${path}`, cause, repo)));

  const stagePath = (repo: string, path: string) =>
    runChecked({ operation: "merge", command: "git", args: ["add", "--", path], cwd: repo });

  // Whole-file pass: the fork's entire change to the file is the rename.
  const resolveWholeFile = Effect.fn("desktop.localSourceUpdates.resolveWholeFile")(function* (
    repo: string,
    entry: UnmergedPath,
  ): Effect.fn.Return<boolean, LocalSourceUpdateError> {
    if (!isRewritableConflict(entry)) return false;
    const base = yield* readStage(repo, entry, 1);
    const ours = yield* readStage(repo, entry, 2);
    const theirs = yield* readStage(repo, entry, 3);
    if ([base, ours, theirs].some(isBinaryText)) return false;
    const resolution = resolveRenameOnlyConflict({ base, ours, theirs });
    if (resolution === null) return false;
    if (resolution.kind === "delete") {
      yield* runChecked({
        operation: "merge",
        command: "git",
        args: ["rm", "--quiet", "--", entry.path],
        cwd: repo,
      });
      return true;
    }
    yield* writeWorkingFile(repo, entry.path, resolution.contents);
    yield* stagePath(repo, entry.path);
    return true;
  });

  // Hunk pass: rewrite the file with diff3 markers and resolve each
  // rename-only hunk. The file is written and staged only when no hunk is
  // left; any leftover aborts the whole merge anyway.
  const resolveHunks = Effect.fn("desktop.localSourceUpdates.resolveHunks")(function* (
    repo: string,
    entry: UnmergedPath,
  ): Effect.fn.Return<boolean, LocalSourceUpdateError> {
    if (!isRewritableConflict(entry) || entry.stages.size !== 3) return false;
    yield* runChecked({
      operation: "merge",
      command: "git",
      args: ["checkout", "--conflict=diff3", "--", entry.path],
      cwd: repo,
    });
    const text = yield* fileSystem
      .readFileString(environment.path.join(repo, entry.path))
      .pipe(
        Effect.mapError((cause) => makeError("merge", `could not read ${entry.path}`, cause, repo)),
      );
    if (isBinaryText(text)) return false;
    const { contents, unresolved } = resolveRenameOnlyHunks(text);
    if (unresolved > 0) return false;
    yield* writeWorkingFile(repo, entry.path, contents);
    yield* stagePath(repo, entry.path);
    return true;
  });

  /** Resolves rename-only conflicts and returns the paths a human still has to merge. */
  const resolveForkConflicts = Effect.fn("desktop.localSourceUpdates.resolveForkConflicts")(
    function* (repo: string): Effect.fn.Return<ReadonlyArray<string>, LocalSourceUpdateError> {
      for (const entry of yield* listUnmergedPaths(repo)) {
        if (entry.path === LOCKFILE_PATH) {
          // Take upstream's lockfile; the install before the build regenerates
          // it from the merged package manifests.
          yield* runChecked({
            operation: "merge",
            command: "git",
            args: ["checkout", "--theirs", "--", entry.path],
            cwd: repo,
          });
          yield* stagePath(repo, entry.path);
          continue;
        }
        yield* resolveWholeFile(repo, entry);
      }
      for (const entry of yield* listUnmergedPaths(repo)) {
        yield* resolveHunks(repo, entry);
      }
      return (yield* listUnmergedPaths(repo)).map((entry) => entry.path);
    },
  );

  // Whatever the rename pass cannot settle (real conflicts, or a merge that no
  // longer builds) goes to a headless Claude Code run limited to file tools: it
  // can edit the checkout but cannot run git or shells or reach the network.
  // The build remains the gate, and nothing is committed before it passes.
  const runMergeAgent = (repo: string, task: string) =>
    runCommand({
      operation: "merge",
      command: "claude",
      args: [
        "-p",
        `${MERGE_AGENT_RULES}\n\n${task}`,
        "--permission-mode",
        "acceptEdits",
        "--disallowedTools",
        "Bash",
        "WebFetch",
        "WebSearch",
        "--allowedTools",
        "Read",
        "Edit",
        "Write",
        "Grep",
        "Glob",
      ],
      cwd: repo,
    }).pipe(
      Effect.timeoutOrElse({
        duration: MERGE_AGENT_TIMEOUT,
        orElse: () => makeError("merge", "the merge agent did not finish in time"),
      }),
      Effect.asVoid,
    );

  /** Hands remaining conflicts to the agent and returns the paths it left unresolved. */
  const resolveWithAgent = Effect.fn("desktop.localSourceUpdates.resolveWithAgent")(function* (
    repo: string,
    paths: ReadonlyArray<string>,
  ): Effect.fn.Return<ReadonlyArray<string>, LocalSourceUpdateError> {
    yield* runMergeAgent(
      repo,
      `These files still have merge conflicts: ${paths.join(", ")}. Resolve every conflict so no file contains conflict markers.`,
    );
    const left: Array<string> = [];
    for (const path of paths) {
      const text = yield* fileSystem
        .readFileString(environment.path.join(repo, path))
        .pipe(Effect.option);
      if (text._tag === "Some" && CONFLICT_MARKER_PATTERN.test(text.value)) {
        left.push(path);
        continue;
      }
      yield* runChecked({
        operation: "merge",
        command: "git",
        args: text._tag === "Some" ? ["add", "--", path] : ["rm", "--quiet", "--", path],
        cwd: repo,
      });
    }
    return left;
  });

  const abortMerge = (repo: string) =>
    runCommand({ operation: "merge", command: "git", args: ["merge", "--abort"], cwd: repo }).pipe(
      Effect.ignore,
    );

  const syncAndBuild = Effect.gen(function* () {
    const inspection = yield* inspect;
    const repo = inspection.repositoryPath;
    if (inspection.behind === 0) {
      const pendingBuild = yield* Ref.get(builtUpdateRef);
      if (pendingBuild) {
        yield* runChecked({
          operation: "push",
          command: "git",
          args: ["push", "origin", "HEAD:main"],
          cwd: repo,
        });
        return pendingBuild;
      }
      return yield* makeError(
        "merge",
        `the fork already contains upstream nightly ${inspection.upstreamTag}`,
        new Error("no upstream commits"),
        repo,
      );
    }
    const mergeMessage = `chore(sync): merge upstream nightly ${inspection.upstreamTag}`;
    // --no-commit leaves the merge open so a failed resolution or build can
    // still be undone with `git merge --abort`. The commit follows the build.
    // The peeled commit is merged (not the tag) so it matches what inspect counted.
    const merge = yield* runCommand({
      operation: "merge",
      command: "git",
      args: ["merge", "--no-ff", "--no-commit", "-m", mergeMessage, inspection.upstreamCommit],
      cwd: repo,
    });
    const buildsDir = environment.path.join(environment.stateDir, SOURCE_UPDATE_BUILDS_DIR);
    // Forgets the pending build too, so install never points at a deleted bundle.
    const removeBuilds = Ref.set(builtUpdateRef, null).pipe(
      Effect.andThen(fileSystem.remove(buildsDir, { recursive: true, force: true })),
      Effect.ignore,
    );
    const built = yield* Effect.gen(function* () {
      if (merge.exitCode !== 0) {
        const output = trimOutput(merge);
        const mergeHead = yield* runCommand({
          operation: "merge",
          command: "git",
          args: ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
          cwd: repo,
        });
        if (mergeHead.exitCode !== 0) {
          return yield* makeError(
            "merge",
            `upstream merge of ${inspection.upstreamTag} failed${output ? `: ${output}` : ""}`,
            new Error(output),
            repo,
          );
        }
        const unresolved = yield* resolveForkConflicts(repo).pipe(
          Effect.flatMap((paths) =>
            paths.length > 0 ? resolveWithAgent(repo, paths) : Effect.succeed(paths),
          ),
        );
        if (unresolved.length > 0) {
          return yield* makeError(
            "merge",
            `merging ${inspection.upstreamTag} left ${unresolved.length} conflict${unresolved.length === 1 ? "" : "s"} that could not be resolved automatically, so the merge was aborted. Merge ${inspection.upstreamTag} into main by hand, push it, then update again. Conflicted: ${describeUnresolvedPaths(unresolved)}`,
            new Error(output),
            repo,
          );
        }
      }
      const timestamp = yield* Clock.currentTimeMillis;
      // A new build supersedes any earlier one that was never installed.
      yield* removeBuilds;
      const outputDir = environment.path.join(buildsDir, `${timestamp}-${process.pid}`);
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
      // Upstream nightlies change dependencies, so install before building.
      yield* runChecked({ operation: "build", command: "vp", args: ["i"], cwd: repo });
      const buildArgs = [
        "run",
        "dist:desktop:artifact",
        "--platform",
        "mac",
        "--target",
        "dir",
        "--arch",
        arch,
        "--build-version",
        inspection.upstreamVersion,
        "--output-dir",
        outputDir,
      ];
      const firstBuild = yield* runCommand({
        operation: "build",
        command: "vp",
        args: buildArgs,
        cwd: repo,
      });
      if (firstBuild.exitCode !== 0) {
        // Upstream reshaped code the fork builds on; give the agent one pass at it.
        yield* runMergeAgent(
          repo,
          `The merged checkout no longer builds. Fix the code so it builds again. Build output (tail):\n${trimOutput(firstBuild)}`,
        );
        yield* runChecked({ operation: "build", command: "vp", args: buildArgs, cwd: repo });
      }
      const applicationBundlePath = yield* findAppBundle(outputDir);
      // Records the merge result, including the regenerated lockfile and any
      // agent fixes; the author comes from the repo config. Hooks are skipped so
      // the formatter does not rewrite upstream files inside the merge commit.
      yield* runChecked({ operation: "merge", command: "git", args: ["add", "-A"], cwd: repo });
      yield* runChecked({
        operation: "merge",
        command: "git",
        args: ["commit", "--no-verify", "--no-edit", "-m", mergeMessage],
        cwd: repo,
      });
      return { applicationBundlePath };
    }).pipe(
      // Nothing is committed until the build succeeds, so any failure or
      // interruption before the commit still aborts the merge cleanly.
      Effect.catchCause((cause) =>
        abortMerge(repo).pipe(
          Effect.andThen(removeBuilds),
          Effect.andThen(Effect.failCause(cause)),
        ),
      ),
    );
    const build = {
      version: inspection.upstreamVersion,
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
          ChildProcess.make(
            "/bin/sh",
            [
              helperPath,
              sourceApp,
              targetApp,
              String(process.pid),
              environment.path.join(environment.stateDir, SOURCE_UPDATE_BUILDS_DIR),
            ],
            {
              cwd: environment.stateDir,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              detached: true,
            },
          ),
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
