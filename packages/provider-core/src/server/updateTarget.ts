/**
 * Launcher scripts that wrap a package-manager install (to set environment
 * variables, say) hide that install from the maintenance resolver. A wrapper
 * names it with a `t3-update-target: <absolute path>` line, and updates then
 * go to the install the wrapper runs. Fork add-on; see docs/user/fork-behavior.md.
 *
 * @module provider-core/server/updateTarget
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const WRAPPER_MAX_BYTES = 16 * 1_024;
// `$` stops before `\n` only, so a CRLF line keeps its `\r` for the trailing class.
const UPDATE_TARGET_LINE = /\bt3-update-target:[ \t]*(\S[^\r\n]*?)[ \t\r]*$/m;

/** The command and real paths a launcher script names as its install, or null. */
export const wrappedUpdateTarget = Effect.fn("wrappedUpdateTarget")(function* (
  realCommandPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const size = yield* fileSystem.stat(realCommandPath).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => Infinity),
  );
  if (size > WRAPPER_MAX_BYTES) return null;
  const script = yield* fileSystem
    .readFileString(realCommandPath)
    .pipe(Effect.orElseSucceed(() => ""));
  const target = UPDATE_TARGET_LINE.exec(script)?.[1];
  if (!target || !(yield* Path.Path).isAbsolute(target)) return null;
  const realTarget = yield* fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => null));
  return realTarget ? { resolvedCommandPath: target, realCommandPath: realTarget } : null;
});
