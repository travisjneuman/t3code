/**
 * Fork add-on: boot-service guards. Keeps `boot-service.log` bounded and refuses a release mirror
 * that is not HTTPS before anything is downloaded.
 *
 * @module cloud/bootServiceGuards
 */
import { cliReleaseBaseUrlProblem } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export const BOOT_SERVICE_LOG_MAX_BYTES = 5 * 1024 * 1024;

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
