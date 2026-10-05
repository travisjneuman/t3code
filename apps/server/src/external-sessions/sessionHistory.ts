/**
 * Sessions older than the sidebar list: the walk cross-agent search reads
 * (session-search/candidates.ts), and the lookup that lets the session view
 * open one of its results. Fork add-on; see docs/internals/external-sessions.md.
 *
 * @module external-sessions/sessionHistory
 */
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { type ExternalSessionSource, listDirectory } from "./ExternalSessionSource.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back search reads, and so how old a session the view can open. */
export const HISTORY_WINDOW_MS = 90 * DAY_MS;
// A rollout lives under the day it started; one started this long before the
// window and still written to inside it is not looked for.
const CODEX_START_SLACK_MS = 365 * DAY_MS;
// One session id names one file; more matches than this are not that session.
const MAX_ID_MATCHES = 4;

const dayDirs = (root: string, oldestMs: number) =>
  Effect.gen(function* () {
    const oldest = new Date(oldestMs);
    const oldestKey =
      oldest.getFullYear() * 10_000 + (oldest.getMonth() + 1) * 100 + oldest.getDate();
    const dirs: Array<string> = [];
    for (const year of yield* listDirectory(root)) {
      for (const month of yield* listDirectory(NodePath.join(root, year))) {
        for (const day of yield* listDirectory(NodePath.join(root, year, month))) {
          const key = Number(year) * 10_000 + Number(month) * 100 + Number(day);
          if (Number.isFinite(key) && key >= oldestKey) {
            dirs.push(NodePath.join(root, year, month, day));
          }
        }
      }
    }
    return dirs;
  });

/**
 * Codex's own discovery looks back a week of day folders; this walks every
 * day folder the slack allows and keeps what the source calls a session file.
 * Its paths are not filtered by mtime; callers that need that stat them.
 */
const codexSessionPaths = (source: ExternalSessionSource, sinceMs: number) =>
  Effect.gen(function* () {
    const root = source.roots[0]?.path;
    if (root === undefined) return [];
    const paths: Array<string> = [];
    for (const dir of yield* dayDirs(root, sinceMs - CODEX_START_SLACK_MS)) {
      for (const name of yield* listDirectory(dir)) {
        paths.push(...(yield* source.sessionPathsFor(NodePath.join(dir, name))));
      }
    }
    return paths;
  });

/** Session paths that may have been active since `sinceMs`, however long ago that is. */
export const historySessionPaths = (
  source: ExternalSessionSource,
  sinceMs: number,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> =>
  source.driver === "codex" ? codexSessionPaths(source, sinceMs) : source.discover(sinceMs);

/**
 * Every store with a file or folder per session names it after the session
 * id: Claude `<id>.jsonl`, Codex `rollout-<time>-<id>.jsonl`, Pi
 * `<time>_<id>.jsonl`, Grok `<id>/`.
 */
const namesSession = (path: string, id: string) => {
  const name = NodePath.basename(path);
  return (
    name === id ||
    name === `${id}.jsonl` ||
    name.endsWith(`-${id}.jsonl`) ||
    name.endsWith(`_${id}.jsonl`)
  );
};

/**
 * Paths in the history window that are named after session `id`, for the
 * caller to summarize. One directory walk; nothing is read beyond it.
 * Antigravity keeps every session in one database the list already reads, so
 * it never gets here.
 */
export const findSessionPaths = (
  source: ExternalSessionSource,
  id: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> =>
  id.length === 0
    ? Effect.succeed([])
    : Effect.map(historySessionPaths(source, Date.now() - HISTORY_WINDOW_MS), (paths) =>
        [...new Set(paths)].filter((path) => namesSession(path, id)).slice(0, MAX_ID_MATCHES),
      );
