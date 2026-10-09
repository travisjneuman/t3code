/**
 * Unarchive a Codex session in Codex itself, through a short-lived
 * `codex app-server` (`thread/unarchive`). T3's archive no longer archives in
 * Codex, but older T3 archives did, and Codex moved those rollouts to
 * `archived_sessions/`; T3 never touches those files. Fork add-on; see docs/internals/external-sessions.md.
 *
 * @module external-sessions/codexNativeArchive
 */
import * as NodeOS from "node:os";

import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { withCodexAppServerClient } from "../provider/CodexProvider.ts";
import { resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ServerSettings from "../serverSettings.ts";
import { codexInstanceHome, enabledInstancesOf } from "./continueExternalSession.ts";

const REQUEST_TIMEOUT = "20 seconds";

export type CodexArchiveMethod = "thread/unarchive";

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const hostEnvironment = yield* HostProcessEnvironment;

  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

  /**
   * The listing reads `~/.codex`, so the session belongs to the enabled
   * instance (built-in first) whose shared home is that directory. Launched
   * the way CodexDriver launches its own app-server for that instance.
   */
  const findInstance = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const listedHome = yield* realPath(path.join(NodeOS.homedir(), ".codex"));
    for (const { config: instance } of enabledInstancesOf(settings, "codex")) {
      const codex = yield* codexInstanceHome(instance, hostEnvironment);
      // A managed instance runs its own Codex install and home.
      if (codex === null || codex.settings.setupMode === "managed") continue;
      if ((yield* realPath(codex.layout.sharedHomePath)) !== listedHome) continue;
      const environment = mergeProviderInstanceEnvironment(instance.environment);
      return {
        binaryPath: expandHomePath(codex.settings.binaryPath),
        homePath: codex.layout.effectiveHomePath ?? "",
        launchArgs: resolveCodexLaunchArgs(codex.settings.launchArgs, environment),
        environment,
      };
    }
    return null;
  }).pipe(Effect.provideService(Path.Path, path));

  /**
   * Runs the request; returns why it could not, or null when Codex did it.
   * Never fails: the T3 side of an archive does not depend on Codex.
   */
  const run = (method: CodexArchiveMethod, threadId: string): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      const instance = yield* findInstance;
      if (instance === null) return "no enabled Codex provider in T3 uses ~/.codex.";
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* withCodexAppServerClient({
            ...instance,
            // Thread-level request; any directory serves.
            cwd: NodeOS.homedir(),
          });
          yield* client.request(method, { threadId });
        }),
      ).pipe(Effect.timeout(REQUEST_TIMEOUT));
      return null;
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        const reason = error instanceof Error ? error.message : String(error);
        return Effect.logWarning("Codex native archive failed", { method, threadId, cause }).pipe(
          Effect.as(reason.length > 0 ? reason : "Codex reported an error."),
        );
      }),
    );

  return { run };
});
