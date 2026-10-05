/**
 * Search over sessions from agents running outside T3: streams each recent
 * transcript through its store's own parser (external-sessions/*Source.ts)
 * and returns the newest sessions with a user or assistant message containing
 * the query. Never writes to another app's files and keeps no index. T3's own
 * threads are searched by ThreadSearch. Fork add-on; see
 * docs/internals/session-search.md.
 *
 * @module session-search/SessionSearch
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  SESSION_SEARCH_MAX_RESULTS,
  type SessionSearchHit,
  type SessionSearchInput,
  type SessionSearchResult,
  type SessionSearchSnippet,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { makeAntigravitySource } from "../external-sessions/antigravitySource.ts";
import { makeClaudeSource } from "../external-sessions/claudeSource.ts";
import { makeCodexSource } from "../external-sessions/codexSource.ts";
import * as ExternalSessions from "../external-sessions/ExternalSessions.ts";
import type {
  ExternalSessionInfo,
  ExternalSessionSource,
} from "../external-sessions/ExternalSessionSource.ts";
import { makeGrokSource } from "../external-sessions/grokSource.ts";
import { makePiSource } from "../external-sessions/piSource.ts";
import { HISTORY_WINDOW_MS } from "../external-sessions/sessionHistory.ts";
import { type Candidates, listCandidates } from "./candidates.ts";
import { cutSnippet, makeMatcher } from "./matcher.ts";
import { scanTranscript } from "./scanTranscript.ts";
import { transcriptLayout } from "./transcriptLayout.ts";

// The session view can open a result this old (external-sessions/sessionHistory.ts).
const WINDOW_MS = HISTORY_WINDOW_MS;
// Typing several queries in a row reuses one directory walk.
const CANDIDATES_TTL_MS = 60 * 1000;
const SCAN_CONCURRENCY = 4;
const TIME_BUDGET_MS = 8 * 1000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export class SessionSearch extends Context.Service<
  SessionSearch,
  {
    /** Newest matching sessions first; T3-owned sessions are left out. */
    readonly search: (input: SessionSearchInput) => Effect.Effect<SessionSearchResult>;
  }
>()("t3/session-search/SessionSearch") {}

const isUnder = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(NodePath.sep) ? root : `${root}${NodePath.sep}`);

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  // The same owned-session set that keeps these sessions out of the sidebar list.
  const externalSessions = yield* ExternalSessions.ExternalSessions;
  const sources: ReadonlyArray<ExternalSessionSource> = [
    makeClaudeSource(),
    makeCodexSource(),
    makeGrokSource(),
    makePiSource(),
    makeAntigravitySource(),
  ];
  // Sessions T3 started itself (scratch threads, worktrees) are T3 threads.
  const excludedRoots = [
    config.baseDir,
    config.worktreesDir,
    NodePath.join(NodeOS.homedir(), ".t3"),
  ];
  const provide = Effect.provideService(FileSystem.FileSystem, fileSystem);

  let cached: { readonly at: number; readonly candidates: Candidates } | null = null;
  const candidates = Effect.gen(function* () {
    if (cached !== null && Date.now() - cached.at < CANDIDATES_TTL_MS) return cached.candidates;
    const fresh = yield* provide(listCandidates(sources, Date.now() - WINDOW_MS));
    cached = { at: Date.now(), candidates: fresh };
    return fresh;
  });

  const search: SessionSearch["Service"]["search"] = (input) =>
    Effect.gen(function* () {
      const limit = input.limit ?? SESSION_SEARCH_MAX_RESULTS;
      const matcher = makeMatcher(input.query);
      const deadline = Date.now() + TIME_BUDGET_MS;
      const since = Date.now() - WINDOW_MS;
      const owned = yield* externalSessions.ownedSessionIds;
      const { transcripts, summaries } = yield* candidates;
      const hits: Array<{ readonly hit: SessionSearchHit; readonly updatedAtMs: number }> = [];
      let complete = true;

      // A path naming an owned session id is not worth reading.
      const ownedPath = (path: string) => {
        const name = NodePath.basename(path);
        return (
          owned.has(path) ||
          owned.has(name) ||
          (name.match(UUID) ?? []).some((id) => owned.has(id.toLowerCase()) || owned.has(id))
        );
      };
      const listable = (info: ExternalSessionInfo, path: string) => {
        const cwd = info.cwd;
        return (
          info.updatedAtMs >= since &&
          !owned.has(info.id) &&
          !owned.has(path) &&
          !(cwd !== null && excludedRoots.some((root) => isUnder(cwd, root)))
        );
      };
      const addHit = (
        source: ExternalSessionSource,
        info: ExternalSessionInfo,
        snippet: SessionSearchSnippet,
      ) =>
        hits.push({
          hit: {
            key: `${source.driver}:${info.id}`,
            driver: source.driver,
            origin: info.origin,
            title: info.title,
            cwd: info.cwd,
            updatedAt: new Date(info.updatedAtMs).toISOString(),
            snippet,
          },
          updatedAtMs: info.updatedAtMs,
        });

      // Newest first, so once `limit` sessions match, every file not yet
      // started is older than all of them and can be left unread.
      yield* Effect.forEach(
        transcripts,
        (candidate) =>
          Effect.gen(function* () {
            if (hits.length >= limit || ownedPath(candidate.path)) return;
            if (Date.now() > deadline) {
              complete = false;
              return;
            }
            const outcome = yield* provide(
              scanTranscript(
                candidate.transcript,
                candidate.source.createParser(),
                matcher,
                transcriptLayout(candidate.source.driver),
                deadline,
              ),
            );
            if (outcome === "timeout") complete = false;
            if (outcome === "timeout" || outcome === "none") return;
            const summary = yield* provide(candidate.source.summarize(candidate.path));
            const info = summary === "hidden" ? undefined : summary[0];
            if (info === undefined || !listable(info, candidate.path)) return;
            const { message, match } = outcome;
            const source = message.role === "user" ? "user" : "assistant";
            addHit(candidate.source, info, cutSnippet(message.text, match, source));
          }),
        { concurrency: SCAN_CONCURRENCY, discard: true },
      );

      // Stores without readable transcripts match on their titles only.
      for (const candidate of summaries) {
        const summary = yield* provide(candidate.source.summarize(candidate.path));
        if (summary === "hidden") continue;
        for (const info of summary) {
          const match = matcher.find(info.title);
          if (match === null || !listable(info, candidate.path)) continue;
          addHit(candidate.source, info, cutSnippet(info.title, match, "title"));
        }
      }

      const sessions = hits
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
        .slice(0, limit)
        .map(({ hit }) => hit);
      return { sessions, complete };
    });

  return SessionSearch.of({ search });
});

export const layer = Layer.effect(SessionSearch, make);
