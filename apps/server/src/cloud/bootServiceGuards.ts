/**
 * Fork add-on: boot-service guards. Keeps `boot-service.log` bounded and refuses a release mirror
 * that is not HTTPS before anything is downloaded.
 *
 * @module cloud/bootServiceGuards
 */
import { cliReleaseBaseUrlProblem } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const BOOT_SERVICE_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The service manager appends to the log for the life of the host, so past the cap it moves to a
 * single `.1` file, replacing the previous one. Best effort: a log that cannot be measured or
 * moved must never block setup or hide the failure being logged. On POSIX a writer that still
 * holds the file keeps appending to `.1` until it restarts, which is harmless.
 */
export const rotateBootServiceLog = (fs: FileSystem.FileSystem, logPath: string) =>
  fs.stat(logPath).pipe(
    Effect.flatMap((info) =>
      Number(info.size) > BOOT_SERVICE_LOG_MAX_BYTES
        ? fs.rename(logPath, `${logPath}.1`)
        : Effect.void,
    ),
    Effect.ignore,
  );

/**
 * Phrased as a `BootServiceCommandError` step so every existing handler of the boot-service error
 * union reports it without a new tag.
 */
export function releaseMirrorCheckStep(baseUrl: string | undefined): string | undefined {
  const problem = cliReleaseBaseUrlProblem(baseUrl);
  return problem === undefined
    ? undefined
    : `checking the release mirror: ${problem.replace(/\.$/, "")}`;
}

/**
 * Fork builds' fix for a launcher protocol change, or undefined for an upstream build. Upstream's
 * names a t3.codes install, which never publishes fork builds, and its `service install` refuses
 * Windows.
 */
export function forkLauncherProtocolBlocked(launcherProtocol: number, version: string) {
  if (!version.includes("+")) {
    return undefined;
  }
  const reason = [
    `The installed service launcher speaks protocol ${launcherProtocol}, but t3@${version} requires protocol ${SERVICE_LAUNCHER_PROTOCOL}.`,
    "A remote update replaces only the server, not the launcher that runs it, so this host needs one local step that restarts its service.",
    "From the fork checkout on the Mac, run `node scripts/tjn-hosts.ts service-install <host> --confirm-idle`.",
    `Without the fleet tool, on Linux or macOS run \`"${process.execPath}" service install\` on this machine.`,
  ].join(" ");
  return { status: "blocked" as const, version, reason };
}
