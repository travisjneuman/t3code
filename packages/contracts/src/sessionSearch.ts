/**
 * Session search: finds sessions from agents running outside T3 (Claude Code,
 * Codex, Grok, Pi, Antigravity) whose messages contain a query. T3's own
 * threads are searched by `orchestration.searchThreads`; a client shows both.
 * Fork add-on; see docs/internals/session-search.md.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const SESSION_SEARCH_WS_METHODS = {
  search: "sessionSearch.search",
} as const;

export const SESSION_SEARCH_MAX_RESULTS = 50;

/** Case-insensitive plain substring, matched against user and assistant message text. */
export const SessionSearchInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SESSION_SEARCH_MAX_RESULTS })),
  ),
});
export type SessionSearchInput = typeof SessionSearchInput.Type;

/** `title` is for stores that keep no readable transcript (Antigravity). */
export const SessionSearchMatchSource = Schema.Literals(["user", "assistant", "title"]);
export type SessionSearchMatchSource = typeof SessionSearchMatchSource.Type;

/** One matching message, cut around the match. `[matchStart, matchEnd)` indexes `text`. */
export const SessionSearchSnippet = Schema.Struct({
  source: SessionSearchMatchSource,
  text: Schema.String.check(Schema.isMaxLength(240)),
  matchStart: NonNegativeInt,
  matchEnd: NonNegativeInt,
});
export type SessionSearchSnippet = typeof SessionSearchSnippet.Type;

export const SessionSearchHit = Schema.Struct({
  /** Same key as the external-sessions list: `<driver>:<provider session id>`. */
  key: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  /** Where the session runs, e.g. "CLI", "Desktop", "VS Code"; null when unknown. */
  origin: Schema.NullOr(Schema.String),
  title: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
  snippet: SessionSearchSnippet,
});
export type SessionSearchHit = typeof SessionSearchHit.Type;

/**
 * Newest first. `complete` is false when the scan hit its time budget before
 * reading every candidate session, so older matches may be missing.
 */
export const SessionSearchResult = Schema.Struct({
  sessions: Schema.Array(SessionSearchHit),
  complete: Schema.Boolean,
});
export type SessionSearchResult = typeof SessionSearchResult.Type;

export const SessionSearchRpc = Rpc.make(SESSION_SEARCH_WS_METHODS.search, {
  payload: SessionSearchInput,
  success: SessionSearchResult,
  error: EnvironmentAuthorizationError,
});
