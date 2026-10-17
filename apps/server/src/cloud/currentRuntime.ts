// @effect-diagnostics nodeBuiltinImport:off
// Fork add-on. The service launcher and the fork's host tool run this without
// the Effect runtime, so it stays on Node built-ins; the host tool ships this
// file verbatim, so its import names must not collide with the tool's own.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const RUNTIME_SENTINEL_FILE = ".install-complete";

/**
 * `runtime/current` holds the active `runtime/versions/<v>` at a path that never changes, so the
 * service unit and OS rules keyed on the exact executable path (VPN split tunneling, firewalls)
 * survive updates. Its files are hard links into the version directory and cost no extra disk.
 */
export const currentRuntimePaths = (baseDir: string, platform: NodeJS.Platform) => {
  const currentDir = NodePath.join(baseDir, "runtime", "current");
  return {
    currentDir,
    entryPath: NodePath.join(currentDir, platform === "win32" ? "t3.exe" : "t3"),
    sentinelPath: NodePath.join(currentDir, RUNTIME_SENTINEL_FILE),
    retiredDir: NodePath.join(baseDir, "runtime", ".current-retired"),
  };
};

// Windows renames a running executable or a loaded library but refuses to rename a
// directory that holds one, so a directory that will not move is emptied entry by entry.
async function retire(source: string, destination: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  try {
    await NodeFSP.rename(source, destination);
    return;
  } catch (error) {
    if (!(await NodeFSP.lstat(source)).isDirectory()) throw error;
  }
  for (const entry of await NodeFSP.readdir(source)) {
    await retire(NodePath.join(source, entry), NodePath.join(destination, entry));
  }
  await NodeFSP.rmdir(source).catch(() => undefined);
}

async function mirror(source: string, destination: string, skip?: string): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  for (const entry of await NodeFSP.readdir(source, { withFileTypes: true })) {
    if (entry.name === skip) continue;
    const from = NodePath.join(source, entry.name);
    const to = NodePath.join(destination, entry.name);
    if (entry.isDirectory()) {
      await mirror(from, to);
    } else if (entry.isSymbolicLink()) {
      await NodeFSP.symlink(await NodeFSP.readlink(from), to);
    } else {
      await NodeFSP.link(from, to).catch(() => NodeFSP.copyFile(from, to));
    }
  }
}

/**
 * Points `runtime/current` at `runtime/versions/<version>` and returns its executable. Callers
 * run it only while no process runs from `runtime/current` other than, possibly, the launcher
 * itself: the launcher starts a server only after the previous one has exited, and its own
 * image is moved aside, never overwritten, then removed by a later call once it has exited.
 */
export async function syncCurrentRuntime(
  baseDir: string,
  version: string,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Also runs without the Effect runtime.
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const current = currentRuntimePaths(baseDir, platform);
  const installed = await NodeFSP.readFile(current.sentinelPath, "utf8").catch(() => undefined);
  if (installed?.trim() === version) return current.entryPath;
  const versionDir = NodePath.join(baseDir, "runtime", "versions", version);
  const source = await NodeFSP.readFile(NodePath.join(versionDir, RUNTIME_SENTINEL_FILE), "utf8");
  if (source.trim() !== version) {
    throw new Error(`t3@${version} runtime is incomplete; runtime/current was left unchanged.`);
  }
  await NodeFSP.rm(current.retiredDir, { recursive: true, force: true }).catch(() => undefined);
  // Removed first so an interrupted switch never looks complete.
  await NodeFSP.rm(current.sentinelPath, { force: true });
  await NodeFSP.mkdir(current.currentDir, { recursive: true });
  const retired = NodePath.join(current.retiredDir, NodeCrypto.randomUUID());
  for (const entry of await NodeFSP.readdir(current.currentDir)) {
    await retire(NodePath.join(current.currentDir, entry), NodePath.join(retired, entry));
  }
  await mirror(versionDir, current.currentDir, RUNTIME_SENTINEL_FILE);
  // A fresh file, not a link: the version directory's sentinel must stay its own.
  const handle = await NodeFSP.open(current.sentinelPath, "w");
  try {
    await handle.writeFile(`${version}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  // A launcher still running from a retired image keeps that file until it exits.
  await NodeFSP.rm(current.retiredDir, { recursive: true, force: true }).catch(() => undefined);
  return current.entryPath;
}
