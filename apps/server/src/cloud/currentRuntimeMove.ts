// @effect-diagnostics nodeBuiltinImport:off
// Fork add-on. An in-app update replaces the server but never the launcher or the
// service file that starts it, so a host service installed before `runtime/current`
// existed would keep running from `runtime/versions/<v>`. The first server that starts
// under such a launcher repoints the service file and restarts once onto the fixed path.
/* oxlint-disable t3code/no-global-process-runtime -- Reads the process tree that launched this server. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { promisify } from "node:util";

import * as Effect from "effect/Effect";

import packageJson from "../../package.json" with { type: "json" };
import { currentRuntimePaths, syncCurrentRuntime } from "./currentRuntime.ts";

// Holds the version that last tried to move, so a supervisor that still starts the old
// launcher afterwards costs one restart, not a restart loop.
const MOVE_ATTEMPT_FILE = ".current-move-attempt";
const FORCED_EXIT_GRACE_MS = 15_000;

const execFile = promisify(NodeChildProcess.execFile);
const run = async (command: string, args: ReadonlyArray<string>) =>
  (await execFile(command, [...args], { timeout: 30_000, windowsHide: true })).stdout.trim();

interface ServiceFile {
  readonly path: string;
  readonly launcherExecutable: string;
}

// The scheduled task runs a cmd script that loops over the launcher, so the script that
// started this server's launcher is the one that names it.
async function windowsServiceFile(launcherPid: number): Promise<ServiceFile | undefined> {
  const script = `$l = Get-CimInstance Win32_Process -Filter "ProcessId = ${launcherPid}"
if (!$l) { exit 0 }
$c = Get-CimInstance Win32_Process -Filter "ProcessId = $($l.ParentProcessId)"
Write-Output $l.ExecutablePath
Write-Output $c.CommandLine`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const [launcherExecutable, commandLine] = (
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded])
  ).split(/\r?\n/);
  const path = commandLine?.match(/[A-Za-z]:\\[^"\r\n]*?\.cmd\b/i)?.[0];
  return launcherExecutable && path ? { path, launcherExecutable } : undefined;
}

async function linuxServiceFile(
  launcherPid: number,
  unit: string,
): Promise<ServiceFile | undefined> {
  const path = await run("systemctl", [
    "--user",
    "show",
    unit,
    "--property=FragmentPath",
    "--value",
  ]);
  const launcherExecutable = await NodeFSP.readlink(`/proc/${launcherPid}/exe`);
  return path ? { path, launcherExecutable } : undefined;
}

// The same launcher forms the fork's host tool accepts (scripts/lib/tjn-hosts/remote.ts).
function namedLauncher(contents: string, platform: "win32" | "linux") {
  const pattern =
    platform === "win32"
      ? /"([^"\r\n]+\\t3\.exe)"\s+__service-launcher/g
      : /^ExecStart=(?:"([^"\r\n]+)"|([^\s"\r\n]+))\s+__service-launcher\s*$/gm;
  const matches = [...contents.matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  const entry = matches[0]![1] ?? matches[0]![2]!;
  return { entry, text: platform === "win32" ? `"${entry}"` : entry };
}

/** Returns true once the service file names `runtime/current` and the service must restart. */
async function moveServiceFile(baseDir: string, version: string): Promise<boolean> {
  const platform = process.platform;
  if (platform !== "win32" && platform !== "linux") return false;
  const same = (a: string, b: string) =>
    platform === "win32"
      ? NodePath.normalize(a).toLowerCase() === NodePath.normalize(b).toLowerCase()
      : NodePath.normalize(a) === NodePath.normalize(b);
  const current = currentRuntimePaths(baseDir, platform);
  const attemptPath = NodePath.join(baseDir, "runtime", MOVE_ATTEMPT_FILE);
  if (same(process.execPath, current.entryPath)) {
    await NodeFSP.rm(attemptPath, { force: true });
    return false;
  }
  const versionsDir = NodePath.join(baseDir, "runtime", "versions");
  const inVersions = (entry: string) =>
    same(NodePath.dirname(NodePath.dirname(entry)), versionsDir);
  if (!inVersions(process.execPath)) return false;
  const attempted = await NodeFSP.readFile(attemptPath, "utf8").catch(() => undefined);
  if (attempted?.trim() === version) return false;

  const unit = process.env.T3_BOOT_SERVICE_UNIT;
  const service =
    platform === "win32"
      ? await windowsServiceFile(process.ppid)
      : unit
        ? await linuxServiceFile(process.ppid, unit)
        : undefined;
  if (service === undefined) return false;
  const contents = await NodeFSP.readFile(service.path);
  const named = namedLauncher(contents.toString("utf8"), platform);
  if (
    named === undefined ||
    !inVersions(named.entry) ||
    !same(named.entry, service.launcherExecutable.replace(/ \(deleted\)$/, ""))
  ) {
    return false;
  }
  const from = Buffer.from(named.text);
  const at = contents.indexOf(from);
  // cmd reads a running script from its saved byte offset after each command, so the
  // launcher line keeps its length: the shorter fixed path is padded with spaces.
  const nextText = platform === "win32" ? `"${current.entryPath}"` : current.entryPath;
  const to = Buffer.from(platform === "win32" ? nextText.padEnd(from.length, " ") : nextText);
  if (
    at === -1 ||
    contents.indexOf(from, at + 1) !== -1 ||
    (platform === "win32" && to.length !== from.length)
  ) {
    return false;
  }

  await NodeFSP.writeFile(attemptPath, `${version}\n`);
  // Filled before the service file names it, so a failure leaves the old file startable.
  await syncCurrentRuntime(baseDir, version, platform);
  const staged = `${service.path}.current-move`;
  const { mode } = await NodeFSP.stat(service.path);
  await NodeFSP.writeFile(
    staged,
    Buffer.concat([contents.subarray(0, at), to, contents.subarray(at + from.length)]),
    { mode: mode & 0o777 },
  );
  await NodeFSP.rename(staged, service.path);
  if (platform === "linux" && unit) {
    await run("systemctl", ["--user", "daemon-reload"]);
    const execStart = await run("systemctl", [
      "--user",
      "show",
      unit,
      "--property=ExecStart",
      "--value",
    ]);
    return execStart.includes(current.entryPath);
  }
  return true;
}

/**
 * Runs once the server is committed and before it accepts commands. When the service file
 * moved, the server exits: the old launcher exits with it, and systemd or the cmd loop
 * starts the launcher again from `runtime/current`, which then starts this version there.
 */
export const moveServiceToCurrentRuntime = (managed: boolean, baseDir: string) =>
  managed
    ? Effect.tryPromise(() => moveServiceFile(baseDir, packageJson.version)).pipe(
        Effect.flatMap((moved) =>
          moved
            ? Effect.logInfo("service now runs from runtime/current; restarting onto it").pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    // Graceful shutdown from here has stalled on Linux, leaving this server
                    // up under the old launcher; layer construction is still waiting on the
                    // activation this parked startup never grants. Exit regardless.
                    setTimeout(() => process.exit(1), FORCED_EXIT_GRACE_MS).unref();
                    process.kill(process.pid, "SIGTERM");
                  }),
                ),
                Effect.andThen(Effect.never),
              )
            : Effect.void,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("could not move the service to runtime/current", { cause }),
        ),
      )
    : Effect.void;
