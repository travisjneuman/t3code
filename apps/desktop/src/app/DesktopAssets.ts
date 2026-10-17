import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { FORK_BRAND_ASSET_PATHS } from "../../../../scripts/lib/fork-brand-assets.mjs"; // Fork add-on: ndev app icon.
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export interface DesktopIconPaths {
  readonly ico: Option.Option<string>;
  readonly icns: Option.Option<string>;
  readonly png: Option.Option<string>;
}

export class DesktopAssetProbeError extends Schema.TaggedError<DesktopAssetProbeError>()(
  "DesktopAssetProbeError",
  {
    fileName: Schema.String,
    candidatePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to probe desktop asset "${this.fileName}" at ${this.candidatePath}.`;
  }
}

export class DesktopAssets extends Context.Service<
  DesktopAssets,
  {
    readonly iconPaths: Effect.Effect<DesktopIconPaths>;
    readonly resolveResourcePath: (
      fileName: string,
    ) => Effect.Effect<Option.Option<string>, DesktopAssetProbeError>;
  }
>()("@t3tools/desktop/app/DesktopAssets") {}

const resolveResourcePath = Effect.fn("desktop.assets.resolveResourcePath")(function* (
  fileName: string,
): Effect.fn.Return<
  Option.Option<string>,
  DesktopAssetProbeError,
  FileSystem.FileSystem | DesktopEnvironment.DesktopEnvironment
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const candidates = environment.resolveResourcePathCandidates(fileName);
  for (const candidate of candidates) {
    const exists = yield* fileSystem
      .exists(candidate)
      .pipe(
        Effect.mapError(
          (cause) => new DesktopAssetProbeError({ fileName, candidatePath: candidate, cause }),
        ),
      );
    if (exists) {
      return Option.some(candidate);
    }
  }
  return Option.none<string>();
});

// Fork add-on: ndev app icon for every brand, as repository-relative paths.
const sourceTreeIconPaths /* Fork add-on */ = {
  ico: FORK_BRAND_ASSET_PATHS.windowsIconIco, // Fork add-on
  macPng: FORK_BRAND_ASSET_PATHS.macIconPng, // Fork add-on
  universalPng: FORK_BRAND_ASSET_PATHS.universalIconPng, // Fork add-on
} as const;

function resolveSourceTreeIconPath(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  ext: keyof DesktopIconPaths,
): string | undefined {
  if (environment.isPackaged || ext === "icns") return undefined;
  // Fork add-on: ndev app icon; no per-brand directory.
  const fileName =
    ext === "ico"
      ? sourceTreeIconPaths.ico // Fork add-on
      : environment.platform === "darwin"
        ? sourceTreeIconPaths.macPng // Fork add-on
        : sourceTreeIconPaths.universalPng; // Fork add-on
  return environment.path.join(environment.rootDir, fileName); // Fork add-on
}

const resolveIconPath = Effect.fn("desktop.assets.resolveIconPath")(function* (
  ext: keyof DesktopIconPaths,
): Effect.fn.Return<
  Option.Option<string>,
  DesktopAssetProbeError,
  FileSystem.FileSystem | DesktopEnvironment.DesktopEnvironment
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const sourceTreeIconPath = resolveSourceTreeIconPath(environment, ext);
  if (sourceTreeIconPath !== undefined) {
    const sourceTreeIconExists = yield* fileSystem.exists(sourceTreeIconPath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopAssetProbeError({
            fileName: `icon.${ext}`,
            candidatePath: sourceTreeIconPath,
            cause,
          }),
      ),
    );
    if (sourceTreeIconExists) {
      return Option.some(sourceTreeIconPath);
    }
  }

  return yield* resolveResourcePath(`icon.${ext}`);
});

/** @public */
export const make = Effect.gen(function* () {
  const context = yield* Effect.context<
    FileSystem.FileSystem | DesktopEnvironment.DesktopEnvironment
  >();
  const [ico, icns, png] = yield* Effect.all(
    [resolveIconPath("ico"), resolveIconPath("icns"), resolveIconPath("png")] as const,
    { concurrency: "unbounded" },
  );
  const iconPaths = { ico, icns, png } satisfies DesktopIconPaths;

  return DesktopAssets.of({
    iconPaths: Effect.succeed(iconPaths),
    resolveResourcePath: Effect.fn("desktop.assets.resolveResourcePath.scoped")(
      function* (fileName) {
        return yield* resolveResourcePath(fileName).pipe(Effect.provide(context));
      },
    ),
  });
});

export const layer = Layer.effect(DesktopAssets, make);
