/**
 * Archived external sessions, kept in `<state dir>/external-sessions-archive.json`
 * rather than the database, so upstream keeps its migration numbering. The
 * list leaves these sessions out; Settings › Archived lists them for
 * unarchive. Fork add-on; see docs/internals/external-sessions.md.
 *
 * @module external-sessions/externalSessionArchive
 */
import * as NodePath from "node:path";

import { ExternalSessionArchivedSession, ExternalSessionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";

const STATE_FILE = "external-sessions-archive.json";

const ArchiveState = Schema.Struct({
  version: Schema.Literal(1),
  sessions: Schema.Array(ExternalSessionArchivedSession),
});
const decodeArchiveState = Schema.decodeUnknownOption(Schema.fromJsonString(ArchiveState));

export interface ExternalSessionArchive {
  /** Newest first; every change publishes the whole set. */
  readonly sessions: SubscriptionRef.SubscriptionRef<ReadonlyArray<ExternalSessionArchivedSession>>;
  readonly get: (key: string) => ExternalSessionArchivedSession | undefined;
  /** Adds or replaces the session's entry, written to disk before it takes effect. */
  readonly put: (
    session: ExternalSessionArchivedSession,
  ) => Effect.Effect<void, ExternalSessionError>;
  readonly remove: (key: string) => Effect.Effect<void, ExternalSessionError>;
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
  let byKey = new Map(initial.map((session) => [session.key, session] as const));
  const sessions = yield* SubscriptionRef.make<ReadonlyArray<ExternalSessionArchivedSession>>(
    sortNewestFirst(byKey),
  );

  // Writes first, so memory never claims what the file does not hold.
  const commit = (next: Map<string, ExternalSessionArchivedSession>) =>
    Effect.gen(function* () {
      const list = sortNewestFirst(next);
      yield* writeFileStringAtomically({
        filePath: statePath,
        contents: `${JSON.stringify({ version: 1, sessions: list })}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) => new ExternalSessionError({ message: "Could not save the archive.", cause }),
        ),
      );
      byKey = next;
      yield* SubscriptionRef.set(sessions, list);
    });

  const archive: ExternalSessionArchive = {
    sessions,
    get: (key) => byKey.get(key),
    put: (session) =>
      lock.withPermits(1)(Effect.suspend(() => commit(new Map(byKey).set(session.key, session)))),
    remove: (key) =>
      lock.withPermits(1)(
        Effect.suspend(() => {
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
  byKey: ReadonlyMap<string, ExternalSessionArchivedSession>,
): ReadonlyArray<ExternalSessionArchivedSession> {
  return [...byKey.values()].sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
}
