/**
 * Claude desktop's own archive, mirrored read-only. The Claude app (its Code
 * tab) keeps one `local_<id>.json` per session under
 * `<Claude app data>/claude-code-sessions/<uuid>/<uuid>/`. Only `cliSessionId`,
 * `isArchived` and a short allowlist of session settings for the details card
 * (model, effort, permission mode, times, completed turns, CLI version, and
 * whether Remote Control was used) are kept from each, plus the file's
 * `local_<id>` name, which Claude's `claude://code/continue` link opens; the
 * rest of the record holds account and bridge identifiers, so it is dropped
 * right after parsing and never logged or sent. T3 never writes these files, so a session
 * archived there is unarchived there. Fork add-on; see
 * docs/internals/external-sessions.md.
 *
 * @module external-sessions/claudeDesktopArchive
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import {
  asCount,
  asRecord,
  asString,
  listDirectory,
  parseJsonObject,
} from "./ExternalSessionSource.ts";

const SESSION_FILE = /^local_[\w-]+\.json$/;
// Under the list's 15-second liveness republish, so each of those ticks
// rescans; the flushes between them reuse the last scan.
const RESCAN_MS = 10 * 1000;
// These files run to tens of kilobytes; a much larger one is not a session record.
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const claudeAppDataDir = (): string => {
  const home = NodeOS.homedir();
  switch (process.platform) {
    case "darwin":
      return NodePath.join(home, "Library", "Application Support", "Claude");
    case "win32":
      return NodePath.join(
        process.env.APPDATA || NodePath.join(home, "AppData", "Roaming"),
        "Claude",
      );
    default:
      return NodePath.join(process.env.XDG_CONFIG_HOME || NodePath.join(home, ".config"), "Claude");
  }
};

/** What Claude desktop records about a session's settings, for the details card. */
export interface ClaudeDesktopSessionMetadata {
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode: string | null;
  readonly createdAtMs: number | null;
  readonly lastActivityAtMs: number | null;
  readonly completedTurns: number | null;
  readonly cliVersion: string | null;
  /** Remote Control was turned on for the session; the bridge ids themselves are dropped. */
  readonly remoteControl: boolean;
}

interface SessionRecord {
  readonly cliSessionId: string;
  readonly archived: boolean;
  readonly metadata: ClaudeDesktopSessionMetadata;
}

const epochMs = (value: unknown): number | null => {
  const ms = asCount(value);
  return ms === null || ms === 0 ? null : ms;
};

/** The CLI session id a record names, whether it is archived, and the allowlisted settings. */
const sessionRecord = (text: string): SessionRecord | null => {
  const record = parseJsonObject(text.trimStart());
  const cliSessionId = asString(record?.cliSessionId);
  if (record === null || cliSessionId === null) return null;
  const turns = asCount(record.completedTurns);
  return {
    cliSessionId,
    archived: record.isArchived === true,
    metadata: {
      model: asString(record.model),
      effort: asString(record.effort),
      permissionMode: asString(record.permissionMode),
      createdAtMs: epochMs(record.createdAt),
      lastActivityAtMs: epochMs(record.lastActivityAt),
      completedTurns: turns === null ? null : Math.round(turns),
      cliVersion: asString(asRecord(record.toolSurfaceSnapshot)?.cliVersion),
      remoteControl: Array.isArray(record.bridgeSessionIds) && record.bridgeSessionIds.length > 0,
    },
  };
};

interface CachedFile {
  readonly mtimeMs: number;
  readonly record: SessionRecord | null;
}

interface Scan {
  readonly archived: ReadonlyMap<string, number>;
  /** Claude desktop's `local_<id>` for each listed (unarchived) CLI session id. */
  readonly localIds: ReadonlyMap<string, string>;
  /** Each CLI session's settings, from its most recently written record. */
  readonly metadata: ReadonlyMap<string, ClaudeDesktopSessionMetadata>;
}

export interface ClaudeDesktopArchive {
  /**
   * Claude Code session ids archived in Claude desktop, each with when its
   * record was last written. Rescanned at most every 10 seconds; a file is
   * re-read only when its mtime changes. Empty where Claude desktop is absent.
   */
  readonly archivedIds: Effect.Effect<ReadonlyMap<string, number>>;
  /**
   * Whether Claude desktop has a record for a CLI session, archived or not;
   * null where it has no records at all (absent, or nothing readable).
   */
  readonly hasRecord: Effect.Effect<((cliSessionId: string) => boolean) | null>;
  /**
   * Claude desktop's `local_<id>` for an unarchived CLI session, or null. A
   * miss rescans at once, so a session just started there is found.
   */
  readonly localSessionId: (cliSessionId: string) => Effect.Effect<string | null>;
  /** Claude desktop's settings for a CLI session, archived or not, or null without a record. */
  readonly sessionMetadata: (
    cliSessionId: string,
  ) => Effect.Effect<ClaudeDesktopSessionMetadata | null>;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = NodePath.join(claudeAppDataDir(), "claude-code-sessions");
  const lock = yield* Semaphore.make(1);
  const files = new Map<string, CachedFile>();
  let current: Scan = { archived: new Map(), localIds: new Map(), metadata: new Map() };
  let scannedAt = Number.NEGATIVE_INFINITY;

  const readRecord = (path: string): Effect.Effect<CachedFile | null> =>
    Effect.gen(function* () {
      const info = yield* fileSystem.stat(path);
      if (info.type !== "File") return null;
      const mtimeMs = Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() });
      const cached = files.get(path);
      if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached;
      const record =
        Number(info.size) > MAX_FILE_BYTES
          ? null
          : sessionRecord(yield* fileSystem.readFileString(path));
      return { mtimeMs, record };
    }).pipe(Effect.orElseSucceed(() => null));

  const scan = Effect.gen(function* () {
    const seen = new Set<string>();
    const archived = new Map<string, number>();
    const localIds = new Map<string, string>();
    const localMtimes = new Map<string, number>();
    const metadata = new Map<string, ClaudeDesktopSessionMetadata>();
    const metadataMtimes = new Map<string, number>();
    // `<account>/<organization>/local_<id>.json`; anything else is skipped.
    for (const account of yield* listDirectory(root)) {
      for (const organization of yield* listDirectory(NodePath.join(root, account))) {
        const dir = NodePath.join(root, account, organization);
        for (const name of yield* listDirectory(dir)) {
          if (!SESSION_FILE.test(name)) continue;
          const path = NodePath.join(dir, name);
          const file = yield* readRecord(path);
          if (file === null) continue;
          seen.add(path);
          files.set(path, file);
          if (file.record === null) continue;
          const { cliSessionId, archived: isArchived } = file.record;
          if (file.mtimeMs >= (metadataMtimes.get(cliSessionId) ?? -1)) {
            metadataMtimes.set(cliSessionId, file.mtimeMs);
            metadata.set(cliSessionId, file.record.metadata);
          }
          if (isArchived) {
            archived.set(cliSessionId, Math.max(archived.get(cliSessionId) ?? 0, file.mtimeMs));
          } else if (file.mtimeMs >= (localMtimes.get(cliSessionId) ?? -1)) {
            localMtimes.set(cliSessionId, file.mtimeMs);
            localIds.set(cliSessionId, name.slice(0, -".json".length));
          }
        }
      }
    }
    for (const path of files.keys()) if (!seen.has(path)) files.delete(path);
    current = { archived, localIds, metadata };
    scannedAt = Date.now();
    return current;
  }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

  const latest = lock.withPermits(1)(
    Effect.suspend(() => (Date.now() - scannedAt < RESCAN_MS ? Effect.succeed(current) : scan)),
  );

  const desktopArchive: ClaudeDesktopArchive = {
    archivedIds: Effect.map(latest, (result) => result.archived),
    hasRecord: Effect.map(latest, ({ archived, localIds }) =>
      archived.size + localIds.size === 0
        ? null
        : (cliSessionId: string) => archived.has(cliSessionId) || localIds.has(cliSessionId),
    ),
    localSessionId: (cliSessionId) =>
      Effect.flatMap(latest, (result) =>
        result.localIds.has(cliSessionId)
          ? Effect.succeed(result.localIds.get(cliSessionId) ?? null)
          : Effect.map(
              lock.withPermits(1)(scan),
              (fresh) => fresh.localIds.get(cliSessionId) ?? null,
            ),
      ),
    sessionMetadata: (cliSessionId) =>
      Effect.map(latest, (result) => result.metadata.get(cliSessionId) ?? null),
  };
  return desktopArchive;
});
