import {
  normalizeRemoteAppTextSize,
  REMOTE_APP_SITES,
  RemoteAppStateSchema,
  type RemoteAppRecentLocation,
  type RemoteAppState,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  REMOTE_APP_SITE_DEFINITIONS,
  sanitizePersistedUrl,
  sanitizeRemoteTitle,
} from "./RemoteAppPolicy.ts";

const RemoteAppStateJson = fromLenientJson(RemoteAppStateSchema);
const decodeState = Schema.decodeEffect(RemoteAppStateJson);
const encodeState = Schema.encodeEffect(RemoteAppStateJson);

export const DEFAULT_REMOTE_APP_STATE: RemoteAppState = {
  schemaVersion: 1,
  activeSurface: "t3code",
  loadState: "not-created",
  currentUrl: REMOTE_APP_SITE_DEFINITIONS.chatgpt.entryUrl,
  currentTitle: "ChatGPT",
  canGoBack: false,
  canGoForward: false,
  recents: [],
  error: null,
};

// Keeps only sites set away from T3's size, rounded and clamped.
const normalizeTextSizes = (
  textSizes: RemoteAppState["textSizes"],
): NonNullable<RemoteAppState["textSizes"]> => {
  const normalized: Partial<Record<(typeof REMOTE_APP_SITES)[number], number>> = {};
  for (const site of REMOTE_APP_SITES) {
    const size = textSizes?.[site];
    const next = size === undefined ? null : normalizeRemoteAppTextSize(size);
    if (next !== null) normalized[site] = next;
  }
  return normalized;
};

export const normalizeRemoteAppState = (state: RemoteAppState): RemoteAppState => ({
  ...state,
  currentUrl: state.currentUrl === null ? null : sanitizePersistedUrl(state.currentUrl),
  currentTitle: sanitizeRemoteTitle(state.currentTitle),
  textSizes: normalizeTextSizes(state.textSizes),
  recents: state.recents
    .map((recent): RemoteAppRecentLocation | null => {
      const url = sanitizePersistedUrl(recent.url);
      return url === null ? null : { url, title: sanitizeRemoteTitle(recent.title) };
    })
    .filter((recent): recent is RemoteAppRecentLocation => recent !== null)
    .slice(0, 20),
});

export class RemoteAppStateStoreWriteError extends Schema.TaggedError<RemoteAppStateStoreWriteError>()(
  "RemoteAppStateStoreWriteError",
  {
    operation: Schema.Literals(["create-directory", "encode", "write-temporary", "replace"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Remote app state persistence failed during ${this.operation}.`;
  }
}

export class RemoteAppStateStore extends Context.Service<
  RemoteAppStateStore,
  {
    readonly get: Effect.Effect<RemoteAppState>;
    readonly set: (state: RemoteAppState) => Effect.Effect<void, RemoteAppStateStoreWriteError>;
    readonly update: (
      update: (state: RemoteAppState) => RemoteAppState,
    ) => Effect.Effect<RemoteAppState, RemoteAppStateStoreWriteError>;
    readonly reset: (
      activeSurface?: RemoteAppState["activeSurface"],
    ) => Effect.Effect<RemoteAppState, RemoteAppStateStoreWriteError>;
  }
>()("@t3tools/desktop/remote-apps/RemoteAppStateStore") {}

const writeState = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly statePath: string;
  readonly state: RemoteAppState;
}): Effect.fn.Return<void, RemoteAppStateStoreWriteError> {
  const directory = input.path.dirname(input.statePath);
  const temporaryPath = `${input.statePath}.${process.pid}.tmp`;
  const encoded = yield* encodeState(normalizeRemoteAppState(input.state)).pipe(
    Effect.mapError(
      (cause) =>
        new RemoteAppStateStoreWriteError({ operation: "encode", path: input.statePath, cause }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new RemoteAppStateStoreWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.writeFileString(temporaryPath, `${encoded}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new RemoteAppStateStoreWriteError({
          operation: "write-temporary",
          path: temporaryPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem
    .rename(temporaryPath, input.statePath)
    .pipe(
      Effect.mapError(
        (cause) =>
          new RemoteAppStateStoreWriteError({ operation: "replace", path: input.statePath, cause }),
      ),
    );
});

const TEMPORARY_STATE_FILE = /^remote-app-state\.json\.(\d+)\.tmp$/;

// A write interrupted by a quit or crash leaves its temporary file behind.
// Only this process writes the state file, so other processes' leftovers are stale.
const removeStaleTemporaryFiles = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly directory: string;
}) {
  const entries = yield* input.fileSystem
    .readDirectory(input.directory)
    .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
  for (const entry of entries) {
    const match = TEMPORARY_STATE_FILE.exec(entry);
    if (match === null || Number(match[1]) === process.pid) continue;
    yield* input.fileSystem
      .remove(input.path.join(input.directory, entry))
      .pipe(Effect.catch(() => Effect.void));
  }
});

const readState = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly statePath: string;
}): Effect.fn.Return<RemoteAppState> {
  const raw = yield* input.fileSystem
    .readFileString(input.statePath)
    .pipe(
      Effect.catchTag("PlatformError", (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.logWarning("Could not read remote app state.", cause).pipe(Effect.as(null)),
      ),
    );
  if (raw === null) return DEFAULT_REMOTE_APP_STATE;

  return yield* decodeState(raw).pipe(
    // Unread badges describe live views, which do not survive a restart.
    Effect.map((state) => ({ ...normalizeRemoteAppState(state), unreadSites: [] })),
    Effect.catchTag("SchemaError", (cause) =>
      input.fileSystem.rename(input.statePath, `${input.statePath}.corrupt-${process.pid}`).pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(
          Effect.logWarning("Could not decode remote app state; using defaults.", cause),
        ),
        Effect.as(DEFAULT_REMOTE_APP_STATE),
      ),
    ),
  );
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const writeLock = yield* Semaphore.make(1);
  const statePath = environment.path.join(environment.stateDir, "remote-app-state.json");
  yield* removeStaleTemporaryFiles({
    fileSystem,
    path: environment.path,
    directory: environment.stateDir,
  });
  const stateRef = yield* Ref.make(yield* readState({ fileSystem, statePath }));

  const persist = (state: RemoteAppState) => {
    const normalized = normalizeRemoteAppState(state);
    return Ref.set(stateRef, normalized).pipe(
      Effect.andThen(
        writeState({ fileSystem, path: environment.path, statePath, state: normalized }),
      ),
      Effect.as(normalized),
    );
  };
  const set = (state: RemoteAppState) => writeLock.withPermit(persist(state)).pipe(Effect.asVoid);
  const update = (updateState: (state: RemoteAppState) => RemoteAppState) =>
    writeLock.withPermit(Effect.flatMap(Ref.get(stateRef), (state) => persist(updateState(state))));

  return RemoteAppStateStore.of({
    get: Ref.get(stateRef),
    set,
    update,
    reset: (activeSurface = "t3code") => {
      const next = { ...DEFAULT_REMOTE_APP_STATE, activeSurface };
      return set(next).pipe(Effect.as(next));
    },
  });
});

export const layer = Layer.effect(RemoteAppStateStore, make);
