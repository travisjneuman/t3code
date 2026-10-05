/**
 * Which session files a search reads: every session each store says was
 * active in the search window, newest first.
 *
 * @module session-search/candidates
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  type ExternalSessionSource,
  statMtimeMs,
} from "../external-sessions/ExternalSessionSource.ts";
import { historySessionPaths } from "../external-sessions/sessionHistory.ts";

export interface TranscriptCandidate {
  readonly source: ExternalSessionSource;
  readonly path: string;
  readonly transcript: string;
  readonly mtimeMs: number;
}

/** A store without readable transcripts (Antigravity); only its titles are searched. */
export interface SummaryCandidate {
  readonly source: ExternalSessionSource;
  readonly path: string;
}

export interface Candidates {
  readonly transcripts: ReadonlyArray<TranscriptCandidate>;
  readonly summaries: ReadonlyArray<SummaryCandidate>;
}

const STAT_CONCURRENCY = 16;

export const listCandidates = (
  sources: ReadonlyArray<ExternalSessionSource>,
  sinceMs: number,
): Effect.Effect<Candidates, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const perSource = yield* Effect.forEach(
      sources,
      (source) => Effect.map(historySessionPaths(source, sinceMs), (paths) => ({ source, paths })),
      { concurrency: "unbounded" },
    );
    const transcripts: Array<TranscriptCandidate> = [];
    const summaries: Array<SummaryCandidate> = [];
    const pending: Array<Omit<TranscriptCandidate, "mtimeMs">> = [];
    for (const { source, paths } of perSource) {
      for (const path of new Set(paths)) {
        const transcript = source.transcriptPath(path);
        if (transcript === null) summaries.push({ source, path });
        else pending.push({ source, path, transcript });
      }
    }
    yield* Effect.forEach(
      pending,
      (candidate) =>
        Effect.map(statMtimeMs(candidate.transcript), (mtimeMs) => {
          if (mtimeMs !== null && mtimeMs >= sinceMs) transcripts.push({ ...candidate, mtimeMs });
        }),
      { concurrency: STAT_CONCURRENCY, discard: true },
    );
    transcripts.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { transcripts, summaries };
  });
