import { UPSTREAM_SYNC_PROMPT_PREFIX } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

const COMMAND_OUTPUT_LIMIT = 16_000;
const LOCAL_UPDATE_HELPER_PATH = "local-source-update-helper.sh";
// Holds at most one build: cleared before each build, after a failed build, and by the install helper.
const SOURCE_UPDATE_BUILDS_DIR = "source-updates";
const LOCKFILE_PATH = "pnpm-lock.yaml";
const MERGE_AGENT_TIMEOUT = "20 minutes";
const CONFLICT_MARKER_PATTERN = /^(?:<{7}|>{7})(?: |$)/mu;
// Overrides the checkout path the build recorded in the packaged package.json.
const SOURCE_REPOSITORY_PATH_ENV = "T3CODE_SOURCE_REPOSITORY_PATH";
const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
const UPSTREAM_REMOTE_URL = "https://github.com/pingdotgg/t3code.git";
// The scheme, user, and host of a GitHub remote: https, ssh, scp-style, or git protocol.
const GITHUB_REMOTE_PREFIX =
  /^(?:(?:https?|ssh|git|git\+ssh):\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com(?::\d+)?[/:]/iu;
/** Every line the fork adds or changes in an upstream file carries this text. */
export const FORK_MARKER = "Fork add-on";
const MERGE_AGENT_RULES = [
  `${UPSTREAM_SYNC_PROMPT_PREFIX} (${UPSTREAM_REPOSITORY}) into this fork.`,
  "Keep upstream's text and code everywhere; never revert or reword an upstream change.",
  `The fork changes upstream files only through lines that contain the text "${FORK_MARKER}", or code directly under a comment line that does; keep every one of them, adapted to upstream's current names and shapes.`,
  "Fork features live in fork-owned files. The fork's identity lives in apps/desktop/src/remote-apps/RemoteAppDistribution.ts and packages/shared/src/branding.ts.",
  "Where upstream renamed or moved code a fork add-on uses, update the add-on and every reference to the moved module or renamed identifier, not just the first.",
  "Change only what the task needs.",
].join(" ");
const NIGHTLY_TAG_GLOB = "v*-nightly.*";
const NIGHTLY_TAG_PATTERN = /^v\d+\.\d+\.\d+-nightly\.\d+\.\d+$/u;
const UNRESOLVED_PATH_LIST_LIMIT = 10;
// Upstream's release workflow stamps the nightly version into these manifests
// before building (scripts/update-release-package-versions.ts). The server
// reports its own package version, so an unstamped build shows a client/server
// mismatch and offers a server update that cannot exist.
const RELEASE_PACKAGE_FILES = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;
const PACKAGE_VERSION_PATTERN = /("version":\s*")[^"]*(")/u;

// scripts/build-desktop-artifact.ts records the checkout it built from here.
const RecordedSourceRepository = Schema.fromJsonString(
  Schema.Struct({ t3codeSourceRepositoryPath: Schema.optionalKey(Schema.String) }),
);
const decodeRecordedSourceRepository = Schema.decodeUnknownEffect(RecordedSourceRepository);

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

/** Pushing to origin is best effort: whoever builds the fork may not be able to push it. */
export type ForkPushResult =
  | { readonly pushed: true }
  | { readonly pushed: false; readonly reason: string };

export interface LocalSourceUpdateBuild {
  readonly version: string;
  readonly applicationBundlePath: string;
  readonly push: ForkPushResult;
}

export interface LocalSourceSyncResult {
  /** Upstream commits the sync merged; 0 when the fork already had them all. */
  readonly merged: number;
  readonly upstreamTag: string;
  /** Null when nothing was merged, so nothing was pushed. */
  readonly push: ForkPushResult | null;
}

export class LocalSourceUpdates extends Context.Service<
  LocalSourceUpdates,
  {
    readonly enabled: Effect.Effect<boolean>;
    /** The source checkout updates build from, when one is configured. */
    readonly repositoryPath: Option.Option<string>;
    readonly inspect: Effect.Effect<LocalSourceUpdateInspection, LocalSourceUpdateError>;
    readonly syncAndBuild: Effect.Effect<LocalSourceUpdateBuild, LocalSourceUpdateError>;
    readonly install: Effect.Effect<void, LocalSourceUpdateError>;
    /** Merges upstream/main with the merge agent and pushes, without building. */
    readonly syncSource: Effect.Effect<LocalSourceSyncResult, LocalSourceUpdateError>;
    /**
     * For the background poller. Merges only the newest upstream nightly,
     * without the merge agent. A conflict or a dropped fork add-on line aborts
     * the merge, and that nightly is skipped until a newer one lands or the
     * sync button (which has the agent) merges it.
     */
    readonly autoSyncSource: Effect.Effect<LocalSourceSyncResult, LocalSourceUpdateError>;
  }
>()("@t3tools/desktop/updates/LocalSourceUpdates") {}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const { logInfo: logSourceInfo, logWarning: logSourceWarning } =
  DesktopObservability.makeComponentLogger("desktop-updater");

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

/**
 * Reduces a GitHub remote URL (https, ssh, scp-style, or git protocol) to a
 * lowercase `owner/repo`. Other hosts come back whole, so they never match.
 */
export function normalizeGitHubRemote(value: string): string {
  return value
    .trim()
    .replace(GITHUB_REMOTE_PREFIX, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "")
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

/**
 * Parses `git grep -c -z` output (`<name>\0<count>` per line). `prefix` strips
 * a tree name such as `HEAD:`.
 */
export function parseMarkerCounts(output: string, prefix = ""): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const line of output.split("\n")) {
    const separator = line.lastIndexOf("\0");
    if (separator < 0) continue;
    const name = line.slice(0, separator);
    const count = Number(line.slice(separator + 1));
    if (!Number.isInteger(count) || count <= 0) continue;
    counts.set(name.startsWith(prefix) ? name.slice(prefix.length) : name, count);
  }
  return counts;
}

export interface MergeChanges {
  /** Old path to new path, for files the merge renamed. */
  readonly renamed: ReadonlyMap<string, string>;
  readonly deleted: ReadonlySet<string>;
}

/** Parses `git diff --name-status -z` output: `<status>\0<path>\0`, with two paths for renames. */
export function parseNameStatus(output: string): MergeChanges {
  const renamed = new Map<string, string>();
  const deleted = new Set<string>();
  const fields = output.split("\0");
  let index = 0;
  while (index < fields.length) {
    const status = fields[index] ?? "";
    if (status.length === 0) {
      index += 1;
      continue;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[index + 1];
      const to = fields[index + 2];
      if (status.startsWith("R") && from && to) renamed.set(from, to);
      index += 3;
      continue;
    }
    const path = fields[index + 1];
    if (status === "D" && path) deleted.add(path);
    index += 2;
  }
  return { renamed, deleted };
}

export interface LostForkMarkers {
  /** The file's path before the merge. */
  readonly path: string;
  /** Where the file is now, or null when the merge deleted it. */
  readonly currentPath: string | null;
  readonly expected: number;
  readonly found: number;
}

const sumCounts = (counts: ReadonlyMap<string, number>): number =>
  Array.from(counts.values()).reduce((total, count) => total + count, 0);

/**
 * Files that hold fewer fork markers after the merge than before. A deleted
 * file only counts when its markers did not reappear elsewhere.
 */
export function findLostForkMarkers(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  changes: MergeChanges,
): ReadonlyArray<LostForkMarkers> {
  const lost: Array<LostForkMarkers> = [];
  const removed: Array<LostForkMarkers> = [];
  for (const [path, expected] of before) {
    if (changes.deleted.has(path)) {
      removed.push({ path, currentPath: null, expected, found: 0 });
      continue;
    }
    const currentPath = changes.renamed.get(path) ?? path;
    const found = after.get(currentPath) ?? 0;
    if (found < expected) lost.push({ path, currentPath, expected, found });
  }
  if (removed.length > 0 && sumCounts(after) < sumCounts(before)) lost.push(...removed);
  return lost;
}

/** The line of `git push` output that says why it failed. */
export function summarizePushFailure(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("hint:"));
  return (
    lines.find((line) => /^(?:fatal|error|remote):|rejected|denied/iu.test(line)) ??
    lines.at(-1) ??
    "git push failed"
  );
}

function describePaths(paths: ReadonlyArray<string>): string {
  const listed = paths.slice(0, UNRESOLVED_PATH_LIST_LIMIT).join(", ");
  const rest = paths.length - UNRESOLVED_PATH_LIST_LIMIT;
  return rest > 0 ? `${listed}, and ${rest} more` : listed;
}

const describeLostMarkers = (lost: ReadonlyArray<LostForkMarkers>): string =>
  describePaths(lost.map((entry) => entry.currentPath ?? entry.path));

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

  // The environment variable wins; otherwise the path the build recorded.
  const resolveRepositoryPath = Effect.gen(function* () {
    const override = yield* Config.String(SOURCE_REPOSITORY_PATH_ENV).pipe(
      Config.option,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const overridePath = Option.getOrUndefined(override)?.trim();
    const packageJsonPath = environment.path.join(environment.appPath, "package.json");
    const recordedPath = overridePath
      ? overridePath
      : yield* fileSystem.readFileString(packageJsonPath).pipe(
          Effect.flatMap(decodeRecordedSourceRepository),
          Effect.map((packageJson) => packageJson.t3codeSourceRepositoryPath?.trim()),
          Effect.orElseSucceed(() => undefined),
        );
    if (!recordedPath) return undefined;
    const resolved = environment.path.resolve(recordedPath);
    // git reports the resolved checkout root, so compare against the real path.
    return yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
  });

  const isGitWorkTree = (path: string) =>
    Effect.all([
      fileSystem.stat(path),
      fileSystem.exists(environment.path.join(path, ".git")),
    ]).pipe(
      Effect.map(([stat, hasGit]) => stat.type === "Directory" && hasGit),
      Effect.orElseSucceed(() => false),
    );

  const supported = environment.platform === "darwin" && environment.isPackaged;
  const repositoryPath = supported ? yield* resolveRepositoryPath : undefined;
  const enabled = repositoryPath !== undefined && (yield* isGitWorkTree(repositoryPath));

  const makeError = (
    operation: LocalSourceUpdateOperation,
    detail: string,
    cause: unknown = new Error(detail),
    path = repositoryPath ?? "(not configured)",
  ) => new LocalSourceUpdateError({ operation, repositoryPath: path, detail, cause });

  const requireRepositoryPath = Effect.gen(function* () {
    if (!supported) {
      return yield* makeError(
        "configuration",
        "local source updates are only supported by packaged macOS builds",
      );
    }
    if (!repositoryPath) {
      return yield* makeError("configuration", "no source repository is configured");
    }
    if (!(yield* isGitWorkTree(repositoryPath))) {
      return yield* makeError("configuration", "the source repository is not a git work tree");
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
    const readStatus = gitChecked("inspect", ["status", "--porcelain=v1", "--untracked-files=all"]);
    let status = yield* readStatus;
    // Quitting mid-build skips the build's own restore and leaves the version
    // stamp behind; that alone must not block the next update.
    const stampedOnly = yield* git("inspect", [
      "diff",
      "--numstat",
      "--",
      ...RELEASE_PACKAGE_FILES,
    ]);
    const dirtyPaths = status.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.slice(3));
    if (
      dirtyPaths.length > 0 &&
      dirtyPaths.every((path) => (RELEASE_PACKAGE_FILES as ReadonlyArray<string>).includes(path)) &&
      stampedOnly.stdout
        .trim()
        .split("\n")
        .every((line) => line.startsWith("1\t1\t"))
    ) {
      yield* restoreReleaseVersion(repo);
      status = yield* readStatus;
    }
    if (status.stdout.trim().length > 0) {
      return yield* makeError(
        "inspect",
        `checkout has local changes:\n${tailOutput(status.stdout.trim())}`,
        new Error("dirty checkout"),
        repo,
      );
    }
    // Nothing names a particular fork: origin is wherever the fork is pushed,
    // as long as it is not upstream itself.
    const origin = yield* git("inspect", ["config", "--get", "remote.origin.url"]);
    const originUrl = origin.exitCode === 0 ? origin.stdout.trim() : "";
    if (!originUrl) {
      return yield* makeError(
        "inspect",
        "the checkout has no origin remote; add the fork you push to as origin",
        new Error("origin missing"),
        repo,
      );
    }
    if (normalizeGitHubRemote(originUrl) === UPSTREAM_REPOSITORY) {
      return yield* makeError(
        "inspect",
        `origin is the official repository (${originUrl}); point origin at your fork`,
        new Error("origin is upstream"),
        repo,
      );
    }
    const upstream = yield* git("inspect", ["config", "--get", "remote.upstream.url"]);
    const upstreamUrl = upstream.exitCode === 0 ? upstream.stdout.trim() : "";
    if (normalizeGitHubRemote(upstreamUrl) !== UPSTREAM_REPOSITORY) {
      return yield* makeError(
        "inspect",
        upstreamUrl
          ? `upstream is ${upstreamUrl}; expected ${UPSTREAM_REPOSITORY}. Run: git remote set-url upstream ${UPSTREAM_REMOTE_URL}`
          : `the checkout has no upstream remote. Run: git remote add upstream ${UPSTREAM_REMOTE_URL}`,
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

  const gitMerge = (repo: string, args: ReadonlyArray<string>) =>
    runChecked({
      operation: "merge",
      command: "git",
      args,
      cwd: repo,
      outputLimit: Number.POSITIVE_INFINITY,
    });

  const listConflictedPaths = (repo: string) =>
    gitMerge(repo, ["diff", "--name-only", "--diff-filter=U", "-z"]).pipe(
      Effect.map((result) => result.stdout.split("\0").filter((path) => path.length > 0)),
    );

  // Conflicts (and a merge that no longer builds) go to a headless Claude Code
  // run limited to file tools: it can edit the checkout but cannot run git or
  // shells or reach the network. It loads only the repo's settings: user-level
  // hooks (such as one that commits at session end) would commit its edits and
  // the build's version stamp before the build passes. The build remains the
  // gate, and nothing is committed before it passes.
  const runMergeAgent = (repo: string, task: string) =>
    runCommand({
      operation: "merge",
      command: "claude",
      args: [
        "-p",
        `${MERGE_AGENT_RULES}\n\n${task}`,
        "--setting-sources",
        "project,local",
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

  /** Hands conflicts to the agent and returns the paths it left unresolved. */
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
      yield* gitMerge(
        repo,
        text._tag === "Some" ? ["add", "--", path] : ["rm", "--quiet", "--", path],
      );
    }
    return left;
  });

  /** Settles the open merge's conflicts and returns the paths still unmerged. */
  const resolveConflicts = Effect.fn("desktop.localSourceUpdates.resolveConflicts")(function* (
    repo: string,
    agent: boolean,
  ): Effect.fn.Return<ReadonlyArray<string>, LocalSourceUpdateError> {
    const conflicted: Array<string> = [];
    for (const path of yield* listConflictedPaths(repo)) {
      if (path !== LOCKFILE_PATH) {
        conflicted.push(path);
        continue;
      }
      // Take upstream's lockfile; the install before the build regenerates it
      // from the merged package manifests.
      yield* gitMerge(repo, ["checkout", "--theirs", "--", path]);
      yield* gitMerge(repo, ["add", "--", path]);
    }
    return conflicted.length > 0 && agent ? yield* resolveWithAgent(repo, conflicted) : conflicted;
  });

  // Counts fork markers per file in HEAD, or in the working tree when `tree` is omitted.
  const countForkMarkers = Effect.fn("desktop.localSourceUpdates.countForkMarkers")(function* (
    repo: string,
    tree?: "HEAD",
  ): Effect.fn.Return<ReadonlyMap<string, number>, LocalSourceUpdateError> {
    const result = yield* runCommand({
      operation: "merge",
      command: "git",
      args: ["grep", "-c", "-z", "-I", "-F", "-e", FORK_MARKER, ...(tree ? [tree] : []), "--"],
      cwd: repo,
      outputLimit: Number.POSITIVE_INFINITY,
    });
    // git grep exits 1 when nothing matches.
    if (result.exitCode === 1) return new Map<string, number>();
    if (result.exitCode !== 0) {
      return yield* makeError(
        "merge",
        `could not count ${FORK_MARKER} lines: ${trimOutput(result)}`,
        new Error(trimOutput(result)),
        repo,
      );
    }
    return parseMarkerCounts(result.stdout, tree ? `${tree}:` : "");
  });

  const findLostMarkers = (repo: string, before: ReadonlyMap<string, number>) =>
    Effect.all([
      countForkMarkers(repo),
      gitMerge(repo, ["diff", "--cached", "-M", "--name-status", "-z", "HEAD"]),
    ]).pipe(
      Effect.map(([after, changes]) =>
        findLostForkMarkers(before, after, parseNameStatus(changes.stdout)),
      ),
    );

  /**
   * Fork changes to upstream files are the lines marked `Fork add-on`, so a file
   * that holds fewer of them after the merge lost a fork hook. The agent gets one
   * pass at restoring the exact lines; whatever is still missing fails the merge.
   */
  const checkForkMarkers = Effect.fn("desktop.localSourceUpdates.checkForkMarkers")(function* (
    repo: string,
    label: string,
    before: ReadonlyMap<string, number>,
    agent: boolean,
  ): Effect.fn.Return<void, LocalSourceUpdateError> {
    const lost = yield* findLostMarkers(repo, before);
    if (lost.length === 0) return;
    if (!agent) {
      return yield* makeError(
        "merge",
        `merging ${label} dropped ${FORK_MARKER} lines from ${describeLostMarkers(lost)}, so the merge was aborted. Sync fork with official T3 Code restores them with the merge agent.`,
        new Error("fork markers lost"),
        repo,
      );
    }
    const sections = yield* Effect.forEach(lost, (entry) =>
      runCommand({
        operation: "merge",
        command: "git",
        args: ["grep", "-n", "-F", "-e", FORK_MARKER, "HEAD", "--", entry.path],
        cwd: repo,
      }).pipe(
        Effect.map((result) => {
          const target = entry.currentPath
            ? `${entry.currentPath} (now ${entry.found} of ${entry.expected} marked lines)`
            : `${entry.path} (deleted by the merge; restore its marked lines where that code now lives)`;
          return `${target}. Marked lines before the merge, as HEAD:path:line:text:\n${result.stdout.trim()}`;
        }),
      ),
    );
    yield* runMergeAgent(
      repo,
      `The merge dropped fork add-on lines. Restore every marked line listed below in the merged file, adapted to upstream's current code, keeping the "${FORK_MARKER}" text on each restored line or on a comment line directly above the block.\n\n${sections.join("\n\n")}`,
    );
    yield* gitMerge(repo, ["add", "-A"]);
    const stillLost = yield* findLostMarkers(repo, before);
    if (stillLost.length > 0) {
      return yield* makeError(
        "merge",
        `merging ${label} dropped ${FORK_MARKER} lines the merge agent could not restore, so the merge was aborted. Merge ${label} into main by hand, push it, then try again. Files: ${describeLostMarkers(stillLost)}`,
        new Error("fork markers lost"),
        repo,
      );
    }
  });

  const abortMerge = (repo: string) =>
    runCommand({ operation: "merge", command: "git", args: ["merge", "--abort"], cwd: repo }).pipe(
      Effect.ignore,
    );

  /**
   * Merges `target` without committing, settles conflicts (the agent unless
   * `agent` is false), and checks that no fork add-on line was dropped. Fails
   * with the merge still open; callers abort it.
   */
  const mergeUpstream = Effect.fn("desktop.localSourceUpdates.mergeUpstream")(function* (
    repo: string,
    target: string,
    label: string,
    message: string,
    agent = true,
  ): Effect.fn.Return<void, LocalSourceUpdateError> {
    const markersBefore = yield* countForkMarkers(repo, "HEAD");
    // --no-commit leaves the merge open so a failed resolution or build can
    // still be undone with `git merge --abort`.
    const merge = yield* runCommand({
      operation: "merge",
      command: "git",
      args: ["merge", "--no-ff", "--no-commit", "-m", message, target],
      cwd: repo,
    });
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
          `upstream merge of ${label} failed${output ? `: ${output}` : ""}`,
          new Error(output),
          repo,
        );
      }
      const unresolved = yield* resolveConflicts(repo, agent);
      if (unresolved.length > 0) {
        return yield* makeError(
          "merge",
          `merging ${label} left ${unresolved.length} conflict${unresolved.length === 1 ? "" : "s"} that could not be resolved automatically, so the merge was aborted. ${agent ? `Merge ${label} into main by hand, push it, then try again.` : "Sync fork with official T3 Code resolves them with the merge agent."} Conflicted: ${describePaths(unresolved)}`,
          new Error(output),
          repo,
        );
      }
    }
    yield* checkForkMarkers(repo, label, markersBefore, agent);
  });

  // Only the working tree is stamped; restoring from the index keeps a pending
  // merge's staged result.
  const stampReleaseVersion = (repo: string, version: string) =>
    Effect.forEach(
      RELEASE_PACKAGE_FILES,
      (file) => {
        const filePath = environment.path.join(repo, file);
        return fileSystem.readFileString(filePath).pipe(
          Effect.flatMap((text) =>
            fileSystem.writeFileString(
              filePath,
              text.replace(PACKAGE_VERSION_PATTERN, `$1${version}$2`),
            ),
          ),
          Effect.mapError((cause) =>
            makeError("build", `could not stamp ${version} into ${file}`, cause, repo),
          ),
        );
      },
      { discard: true },
    );

  const restoreReleaseVersion = (repo: string) =>
    runCommand({
      operation: "build",
      command: "git",
      args: ["checkout", "--", ...RELEASE_PACKAGE_FILES],
      cwd: repo,
    }).pipe(Effect.ignore);

  const hasStagedChanges = (repo: string) =>
    runCommand({
      operation: "merge",
      command: "git",
      args: ["diff", "--cached", "--quiet"],
      cwd: repo,
    }).pipe(Effect.map((result) => result.exitCode !== 0));

  // Pushes only to origin, never to upstream. A failed push never fails the
  // sync or build: the merge stands locally and the result says why it was skipped.
  const pushFork = Effect.fn("desktop.localSourceUpdates.pushFork")(function* (repo: string) {
    const result = yield* runCommand({
      operation: "push",
      command: "git",
      args: ["push", "origin", "HEAD:main"],
      cwd: repo,
    }).pipe(
      Effect.catchTag("LocalSourceUpdateError", (error) =>
        Effect.succeed<CommandResult>({ stdout: "", stderr: error.message, exitCode: -1 }),
      ),
    );
    if (result.exitCode === 0) {
      yield* logSourceInfo("pushed the fork to origin", { repositoryPath: repo });
      return { pushed: true } satisfies ForkPushResult;
    }
    const reason = summarizePushFailure(trimOutput(result));
    yield* logSourceWarning("fork push skipped", {
      repositoryPath: repo,
      reason,
      exitCode: result.exitCode,
    });
    return { pushed: false, reason } satisfies ForkPushResult;
  });

  // Sync and update both rewrite the checkout, so they never overlap.
  const repositoryLock = yield* Semaphore.make(1);

  const syncAndBuild = Effect.gen(function* () {
    const inspection = yield* inspect;
    const repo = inspection.repositoryPath;
    const merging = inspection.behind > 0;
    if (!merging) {
      const pendingBuild = yield* Ref.get(builtUpdateRef);
      if (pendingBuild) {
        return { ...pendingBuild, push: yield* pushFork(repo) } satisfies LocalSourceUpdateBuild;
      }
      // Sync already merged this nightly; it still needs building when the
      // running app predates it.
      if (environment.appVersion === inspection.upstreamVersion) {
        return yield* makeError(
          "merge",
          `this build already runs upstream nightly ${inspection.upstreamTag}`,
          new Error("no upstream commits"),
          repo,
        );
      }
    }
    const mergeMessage = `chore(sync): merge upstream nightly ${inspection.upstreamTag}`;
    const buildsDir = environment.path.join(environment.stateDir, SOURCE_UPDATE_BUILDS_DIR);
    // Forgets the pending build too, so install never points at a deleted bundle.
    const removeBuilds = Ref.set(builtUpdateRef, null).pipe(
      Effect.andThen(fileSystem.remove(buildsDir, { recursive: true, force: true })),
      Effect.ignore,
    );
    // Without a merge to abort, uncommitted agent build fixes are stashed so the
    // checkout stays clean for the next attempt.
    const restoreCheckout = merging
      ? abortMerge(repo)
      : runCommand({
          operation: "build",
          command: "git",
          args: [
            "stash",
            "push",
            "--include-untracked",
            "-m",
            "local source update: unbuilt fixes",
          ],
          cwd: repo,
        }).pipe(Effect.ignore);
    const built = yield* Effect.gen(function* () {
      if (merging) {
        // The peeled commit is merged (not the tag) so it matches what inspect counted.
        yield* mergeUpstream(repo, inspection.upstreamCommit, inspection.upstreamTag, mergeMessage);
      }
      const timestamp = yield* Clock.currentTimeMillis;
      // A new build supersedes any earlier one that was never installed.
      yield* removeBuilds;
      const outputDir = environment.path.join(buildsDir, `${timestamp}-${process.pid}`);
      yield* fileSystem
        .makeDirectory(outputDir, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            makeError("build", `could not create local build output ${outputDir}`, cause, repo),
          ),
        );
      const arch = environment.runtimeInfo.appArch;
      if (arch !== "arm64" && arch !== "x64") {
        return yield* makeError(
          "build",
          `unsupported desktop architecture ${arch}`,
          new Error("unsupported architecture"),
          repo,
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
      yield* Effect.gen(function* () {
        yield* stampReleaseVersion(repo, inspection.upstreamVersion);
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
      }).pipe(Effect.ensuring(restoreReleaseVersion(repo)));
      const applicationBundlePath = yield* findAppBundle(outputDir);
      // Records the merge result (or, without a merge, the regenerated lockfile
      // and agent fixes); the author comes from the repo config. Hooks are
      // skipped so the formatter does not rewrite upstream files.
      yield* runChecked({ operation: "merge", command: "git", args: ["add", "-A"], cwd: repo });
      if (merging || (yield* hasStagedChanges(repo))) {
        yield* runChecked({
          operation: "merge",
          command: "git",
          args: [
            "commit",
            "--no-verify",
            "--no-edit",
            "-m",
            merging
              ? mergeMessage
              : `fix(desktop): build upstream nightly ${inspection.upstreamTag}`,
          ],
          cwd: repo,
        });
      }
      return { applicationBundlePath };
    }).pipe(
      // Nothing is committed until the build succeeds, so any failure or
      // interruption before the commit still restores the checkout.
      Effect.catchCause((cause) =>
        restoreCheckout.pipe(Effect.andThen(removeBuilds), Effect.andThen(Effect.failCause(cause))),
      ),
    );
    const push = yield* pushFork(repo);
    const build = {
      version: inspection.upstreamVersion,
      applicationBundlePath: built.applicationBundlePath,
      push,
    } satisfies LocalSourceUpdateBuild;
    yield* Ref.set(builtUpdateRef, build);
    return build;
  }).pipe(
    repositoryLock.withPermits(1),
    Effect.withSpan("desktop.localSourceUpdates.syncAndBuild"),
  );

  // The upstream commit the background sync could not merge cleanly.
  const autoSyncBlockedRef = yield* Ref.make<string | null>(null);

  // Merges upstream into the fork without building. The sync button (agent)
  // takes every upstream/main commit; the background sync takes only the
  // newest nightly, so the fork moves when upstream releases and the update
  // button then builds that release.
  const syncUpstream = (agent: boolean) =>
    Effect.gen(function* () {
      const inspection = yield* inspect;
      const repo = inspection.repositoryPath;
      const git = (args: ReadonlyArray<string>) =>
        runChecked({ operation: "merge", command: "git", args, cwd: repo });
      // inspect just fetched upstream/main and its nightly tags.
      const target = agent
        ? (yield* git(["rev-parse", "--verify", "upstream/main^{commit}"])).stdout.trim()
        : inspection.upstreamCommit;
      const behind = agent
        ? Number((yield* git(["rev-list", "--count", `HEAD..${target}`])).stdout.trim())
        : inspection.behind;
      if (behind === 0 || (!agent && (yield* Ref.get(autoSyncBlockedRef)) === target)) {
        return {
          merged: 0,
          upstreamTag: inspection.upstreamTag,
          push: null,
        } satisfies LocalSourceSyncResult;
      }
      const label = agent
        ? `upstream main ${target.slice(0, 10)}`
        : `upstream nightly ${inspection.upstreamTag}`;
      const message = `chore(sync): merge ${label}`;
      yield* Effect.gen(function* () {
        yield* mergeUpstream(repo, target, label, message, agent);
        yield* git(["commit", "--no-verify", "--no-edit", "-m", message]);
      }).pipe(
        Effect.catchCause((cause) =>
          abortMerge(repo).pipe(
            Effect.andThen(agent ? Effect.void : Ref.set(autoSyncBlockedRef, target)),
            Effect.andThen(Effect.failCause(cause)),
          ),
        ),
      );
      return {
        merged: behind,
        upstreamTag: inspection.upstreamTag,
        push: yield* pushFork(repo),
      } satisfies LocalSourceSyncResult;
    }).pipe(
      repositoryLock.withPermits(1),
      Effect.withSpan(
        agent
          ? "desktop.localSourceUpdates.syncSource"
          : "desktop.localSourceUpdates.autoSyncSource",
      ),
    );

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
    enabled: Effect.succeed(enabled),
    repositoryPath: Option.fromNullishOr(repositoryPath),
    // Locked so a poll never inspects mid-merge.
    inspect: inspect.pipe(repositoryLock.withPermits(1)),
    syncAndBuild,
    install,
    syncSource: syncUpstream(true),
    autoSyncSource: syncUpstream(false),
  });
});

export const layer = Layer.effect(LocalSourceUpdates, make);
