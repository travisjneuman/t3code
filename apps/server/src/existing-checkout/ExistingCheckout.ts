/**
 * Finds a repository already checked out on this machine, so Add to another machine can add it
 * in place. It looks only where this machine keeps projects: the add-project folder (home when
 * unset) and the folders holding its existing projects, each one level deep. That finds a
 * checkout whose folder name differs per machine, such as a workspace repository that is itself
 * the parent of the other projects. Given a folder, it checks only that one, which may sit
 * anywhere on the machine. Fork add-on: existing checkout.
 *
 * @module existing-checkout/ExistingCheckout
 */
import {
  type ExistingCheckoutFindInput,
  type ExistingCheckoutFindResult,
  repositoryGroupingKeyOf,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/** Bounds a folder like home with many entries; each one costs only a stat unless it holds `.git`. */
const MAX_ENTRIES_PER_FOLDER = 500;

export class ExistingCheckout extends Context.Service<
  ExistingCheckout,
  {
    readonly find: (input: ExistingCheckoutFindInput) => Effect.Effect<ExistingCheckoutFindResult>;
  }
>()("t3/existing-checkout/ExistingCheckout") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettingsService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

  const isCheckoutOf = (repositoryKey: string) => (folder: string) =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(path.join(folder, ".git")))) return false;
      const identity = yield* identities.resolve(folder);
      return identity !== null && repositoryGroupingKeyOf(identity) === repositoryKey;
    }).pipe(Effect.orElseSucceed(() => false));

  const firstCheckout = (folders: ReadonlyArray<string>, repositoryKey: string) =>
    Effect.forEach(folders, isCheckoutOf(repositoryKey), { concurrency: 8 }).pipe(
      Effect.map((matches) => folders.find((_, index) => matches[index]) ?? null),
    );

  const checkFolder = (folder: string, repositoryKey: string, home: string) =>
    Effect.gen(function* () {
      const expanded = expandHomePath(folder, home);
      if (!path.isAbsolute(expanded)) return null;
      const resolved = path.resolve(expanded);
      const identity = yield* identities.resolve(resolved);
      if (identity === null || repositoryGroupingKeyOf(identity) !== repositoryKey) return null;
      // Git reports forward slashes on Windows; resolve gives the machine's own separator.
      return identity.rootPath ? path.resolve(identity.rootPath) : resolved;
    }).pipe(Effect.orElseSucceed(() => null));

  const find = Effect.fn("ExistingCheckout.find")(function* (input: ExistingCheckoutFindInput) {
    const home = yield* HostProcess.HomeDirectory;
    if (input.folder !== undefined) {
      return { repositoryRoot: yield* checkFolder(input.folder, input.repositoryKey, home) };
    }
    const baseDirectory = yield* settings.getSettings.pipe(
      Effect.map((current) => current.addProjectBaseDirectory.trim()),
      Effect.orElseSucceed(() => ""),
    );
    const rows = yield* projects.list().pipe(Effect.orElseSucceed(() => []));
    const places = [
      ...new Set(
        [
          baseDirectory.length > 0 ? expandHomePath(baseDirectory, home) : home,
          ...rows.map((row) => path.dirname(row.workspaceRoot)),
        ]
          .filter((folder) => path.isAbsolute(folder))
          .map((folder) => path.resolve(folder)),
      ),
    ];
    const name = input.repositoryKey.split("/").at(-1) ?? "";

    const likely = [
      ...new Set(places.flatMap((place) => (name ? [path.join(place, name), place] : [place]))),
    ];
    const found = yield* firstCheckout(likely, input.repositoryKey);
    if (found !== null) return { repositoryRoot: found };

    const children = yield* Effect.forEach(places, (place) =>
      fileSystem.readDirectory(place).pipe(
        Effect.map((names) =>
          names.slice(0, MAX_ENTRIES_PER_FOLDER).map((entry) => path.join(place, entry)),
        ),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      ),
    );
    const seen = new Set(likely);
    const rest = [...new Set(children.flat())].filter((folder) => !seen.has(folder));
    return { repositoryRoot: yield* firstCheckout(rest, input.repositoryKey) };
  });

  return ExistingCheckout.of({ find });
});

export const layer = Layer.effect(ExistingCheckout, make);
