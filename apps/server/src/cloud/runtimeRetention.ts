// @effect-diagnostics nodeBuiltinImport:off
// Fork add-on. An in-app update replaces the server but the launcher keeps running the code
// it started with, and nothing removes the versions an update leaves behind. After each
// committed update the first server restarts a stale launcher once onto the new code, then
// removes the runtimes installed before the active one and the update's leftovers.
/* oxlint-disable t3code/no-global-process-runtime -- Reads the launcher's environment. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { restartService } from "./currentRuntimeMove.ts";
import { LAUNCHER_VERSION_ENV, SERVICE_RUNTIME_VERSION } from "./runtimeVersion.ts";
import { parseServiceState, SERVICE_STATE_FILE } from "./serviceProtocol.ts";

// Holds the version that last restarted the launcher, so a supervisor that still starts an
// old launcher costs one restart, not a restart loop.
const REFRESH_ATTEMPT_FILE = ".launcher-refresh-attempt";
const SENTINEL_FILE = ".install-complete";
// An in-app install stages under versions/ while it holds the install lock; one this old crashed.
const STALE_STAGING_MS = 60 * 60_000;

/** Returns true when the launcher runs older code and this server should restart it. */
async function launcherNeedsRefresh(runtimeDir: string, version: string): Promise<boolean> {
  const attemptPath = NodePath.join(runtimeDir, REFRESH_ATTEMPT_FILE);
  if (process.env[LAUNCHER_VERSION_ENV] === version) {
    await NodeFSP.rm(attemptPath, { force: true });
    return false;
  }
  const attempted = await NodeFSP.readFile(attemptPath, "utf8").catch(() => undefined);
  if (attempted?.trim() === version) return false;
  await NodeFSP.writeFile(attemptPath, `${version}\n`);
  return true;
}

const mtime = (path: string) =>
  NodeFSP.stat(path).then(
    (stats) => stats.mtimeMs,
    () => undefined,
  );

// The sentinel goes first, so a tree that fails halfway never reads as an installed runtime.
async function removeTree(dir: string, sentinel?: string): Promise<boolean> {
  try {
    if (sentinel !== undefined) await NodeFSP.rm(sentinel, { force: true });
    await NodeFSP.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps the active runtime and newer pending candidates, but removes a failed trial after
 * rollback. Files Windows still holds open are reported and retried at the next start.
 */
async function pruneRuntimes(runtimeDir: string, version: string) {
  const state = parseServiceState(
    await NodeFSP.readFile(NodePath.join(runtimeDir, SERVICE_STATE_FILE), "utf8").catch(() => ""),
  );
  if (state?.activeVersion !== version || state.update?.status === "pending") return undefined;
  const versionsDir = NodePath.join(runtimeDir, "versions");
  const activeInstalledAt = await mtime(NodePath.join(versionsDir, version, SENTINEL_FILE));
  if (activeInstalledAt === undefined) return undefined;
  const removed: Array<string> = [];
  const kept: Array<string> = [];
  const now = Date.now();
  for (const entry of await NodeFSP.readdir(versionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === version) continue;
    const dir = NodePath.join(versionsDir, entry.name);
    const staging = entry.name.startsWith(".staging-");
    const sentinel = staging ? undefined : NodePath.join(dir, SENTINEL_FILE);
    const installedAt =
      (sentinel === undefined ? undefined : await mtime(sentinel)) ?? (await mtime(dir));
    if (installedAt === undefined) continue;
    const failedTarget =
      state.update !== undefined &&
      state.update.status !== "committed" &&
      entry.name === state.update.targetVersion;
    const stale = failedTarget || (staging ? now - installedAt > STALE_STAGING_MS : installedAt < activeInstalledAt);
    if (!stale) continue;
    ((await removeTree(dir, sentinel)) ? removed : kept).push(entry.name);
  }
  // A committed update has no use for its database backup or the retired runtime/current.
  for (const name of ["db-backup", ".current-retired"]) {
    const dir = NodePath.join(runtimeDir, name);
    if ((await mtime(dir)) !== undefined && !(await removeTree(dir))) kept.push(name);
  }
  return { removed, kept };
}

/**
 * Runs after `moveServiceToCurrentRuntime`, once the server is committed and before it accepts
 * commands, so no update can start while runtimes are removed.
 */
export const refreshLauncherAndPruneRuntimes = (managed: boolean, baseDir: string) => {
  if (!managed) return Effect.void;
  const runtimeDir = NodePath.join(baseDir, "runtime");
  return Effect.tryPromise(() => launcherNeedsRefresh(runtimeDir, SERVICE_RUNTIME_VERSION)).pipe(
    Effect.flatMap((refresh) =>
      refresh
        ? restartService("the service launcher runs older code; restarting it onto this version")
        : process.env[LAUNCHER_VERSION_ENV] === SERVICE_RUNTIME_VERSION
          ? Effect.tryPromise(() => pruneRuntimes(runtimeDir, SERVICE_RUNTIME_VERSION)).pipe(
              Effect.flatMap((result) =>
                result === undefined || result.removed.length + result.kept.length === 0
                  ? Effect.void
                  : result.kept.length > 0
                    ? Effect.logWarning("runtime cleanup incomplete; retained paths need attention", result)
                    : Effect.logInfo("removed retired runtimes and recovery files", result),
              ),
            )
          : // A launcher that kept old code after its restart may run from an old version.
            Effect.logWarning("the service launcher still runs older code; old runtimes kept"),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("could not refresh the launcher or remove old runtimes", { cause }),
    ),
  );
};
