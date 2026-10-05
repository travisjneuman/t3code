/**
 * Claude desktop's own archive, mirrored read-only. The Claude app (its Code
 * tab) keeps one `local_<id>.json` per session under
 * `<Claude app data>/claude-code-sessions/<uuid>/<uuid>/`. Only `cliSessionId`
 * and `isArchived` are kept from each; the rest of the record holds account
 * and bridge identifiers, so it is dropped right after parsing and never
 * logged or sent. T3 never writes these files, so a session archived there is
 * unarchived there. Fork add-on; see
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

import { asString, listDirectory, parseJsonObject } from "./ExternalSessionSource.ts";

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

/** The archived CLI session id a record names, or null; nothing else leaves here. */
const archivedSessionId = (text: string): string | null => {
  const record = parseJsonObject(text.trimStart());
  return record?.isArchived === true ? asString(record.cliSessionId) : null;
};

interface CachedFile {
  readonly mtimeMs: number;
  readonly archivedId: string | null;
}

export interface ClaudeDesktopArchive {
  /**
   * Claude Code session ids archived in Claude desktop, each with when its
   * record was last written. Rescanned at most every 10 seconds; a file is
   * re-read only when its mtime changes. Empty where Claude desktop is absent.
   */
  readonly archivedIds: Effect.Effect<ReadonlyMap<string, number>>;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = NodePath.join(claudeAppDataDir(), "claude-code-sessions");
  const lock = yield* Semaphore.make(1);
  const files = new Map<string, CachedFile>();
  let archived: ReadonlyMap<string, number> = new Map();
  let scannedAt = Number.NEGATIVE_INFINITY;

  const readRecord = (path: string): Effect.Effect<CachedFile | null> =>
    Effect.gen(function* () {
      const info = yield* fileSystem.stat(path);
      if (info.type !== "File") return null;
      const mtimeMs = Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() });
      const cached = files.get(path);
      if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached;
      const archivedId =
        Number(info.size) > MAX_FILE_BYTES
          ? null
          : archivedSessionId(yield* fileSystem.readFileString(path));
      return { mtimeMs, archivedId };
    }).pipe(Effect.orElseSucceed(() => null));

  const scan = Effect.gen(function* () {
    const seen = new Set<string>();
    const next = new Map<string, number>();
    // `<account>/<organization>/local_<id>.json`; anything else is skipped.
    for (const account of yield* listDirectory(root)) {
      for (const organization of yield* listDirectory(NodePath.join(root, account))) {
        const dir = NodePath.join(root, account, organization);
        for (const name of yield* listDirectory(dir)) {
          if (!SESSION_FILE.test(name)) continue;
          const path = NodePath.join(dir, name);
          const record = yield* readRecord(path);
          if (record === null) continue;
          seen.add(path);
          files.set(path, record);
          if (record.archivedId === null) continue;
          next.set(record.archivedId, Math.max(next.get(record.archivedId) ?? 0, record.mtimeMs));
        }
      }
    }
    for (const path of files.keys()) if (!seen.has(path)) files.delete(path);
    archived = next;
    scannedAt = Date.now();
    return archived;
  }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

  const desktopArchive: ClaudeDesktopArchive = {
    archivedIds: lock.withPermits(1)(
      Effect.suspend(() => (Date.now() - scannedAt < RESCAN_MS ? Effect.succeed(archived) : scan)),
    ),
  };
  return desktopArchive;
});
