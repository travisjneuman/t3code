/**
 * Hermes sessions archived from T3, kept in `<state dir>/hermes-sessions-archive.json`
 * so Settings › Archived can list them and unarchive them in Hermes. Hermes
 * itself hides archived sessions from its list, so this file is what
 * remembers their titles. Fork add-on: Hermes provider.
 *
 * @module hermes/hermesSessionArchive
 */
import * as NodePath from "node:path";

import { HermesArchivedSession, HermesSessionsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";

const STATE_FILE = "hermes-sessions-archive.json";

const ArchiveState = Schema.Struct({
  version: Schema.Literal(1),
  sessions: Schema.Array(HermesArchivedSession),
});
const decodeArchiveState = Schema.decodeUnknownOption(Schema.fromJsonString(ArchiveState));

export const archiveKey = (instanceId: string, sessionId: string) =>
  `${instanceId}\u0000${sessionId}`;

export interface HermesSessionArchive {
  /** Newest first. */
  readonly list: Effect.Effect<ReadonlyArray<HermesArchivedSession>>;
  readonly get: (instanceId: string, sessionId: string) => HermesArchivedSession | undefined;
  readonly put: (session: HermesArchivedSession) => Effect.Effect<void, HermesSessionsError>;
  readonly remove: (
    instanceId: string,
    sessionId: string,
  ) => Effect.Effect<void, HermesSessionsError>;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const statePath = NodePath.join(config.stateDir, STATE_FILE);
  const lock = yield* Semaphore.make(1);

  const stored = yield* fileSystem.readFileString(statePath).pipe(Effect.option);
  const initial = Option.isSome(stored)
    ? Option.match(decodeArchiveState(stored.value), {
        onNone: () => [],
        onSome: (state) => state.sessions,
      })
    : [];
  let byKey = new Map(
    initial.map((session) => [archiveKey(session.instanceId, session.id), session] as const),
  );

  // Writes first, so memory never claims what the file does not hold.
  const commit = (next: Map<string, HermesArchivedSession>) =>
    writeFileStringAtomically({
      filePath: statePath,
      contents: `${JSON.stringify({ version: 1, sessions: sortNewestFirst(next) })}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) => new HermesSessionsError({ message: "Could not save the archive.", cause }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          byKey = next;
        }),
      ),
    );

  const archive: HermesSessionArchive = {
    list: Effect.sync(() => sortNewestFirst(byKey)),
    get: (instanceId, sessionId) => byKey.get(archiveKey(instanceId, sessionId)),
    put: (session) =>
      lock.withPermits(1)(
        Effect.suspend(() =>
          commit(new Map(byKey).set(archiveKey(session.instanceId, session.id), session)),
        ),
      ),
    remove: (instanceId, sessionId) =>
      lock.withPermits(1)(
        Effect.suspend(() => {
          const key = archiveKey(instanceId, sessionId);
          if (!byKey.has(key)) return Effect.void;
          const next = new Map(byKey);
          next.delete(key);
          return commit(next);
        }),
      ),
  };
  return archive;
});

function sortNewestFirst(
  byKey: ReadonlyMap<string, HermesArchivedSession>,
): ReadonlyArray<HermesArchivedSession> {
  return [...byKey.values()].sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
}
