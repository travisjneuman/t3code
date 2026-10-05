/**
 * Session search: sessions from agents running outside T3 whose messages
 * contain the sidebar search query, from every connected environment. Fork
 * add-on; the sidebar shows them under T3's own thread results.
 */
import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  SESSION_SEARCH_WS_METHODS,
  type EnvironmentId,
  type SessionSearchHit,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSummaries } from "../state/presentation";
import { useDebouncedValue } from "../state/queries";

// Each search reads transcripts on the server, so wait a little longer than thread search.
const DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

export interface SessionSearchEntry {
  readonly environmentId: EnvironmentId;
  /** Set only when more than one environment returned matches. */
  readonly environmentLabel: string | null;
  readonly hit: SessionSearchHit;
}

interface SessionSearchState {
  readonly entries: ReadonlyArray<SessionSearchEntry>;
  readonly isLoading: boolean;
  /** False when a server stopped at its time budget, so older matches may be missing. */
  readonly complete: boolean;
}

const EMPTY_STATE: SessionSearchState = { entries: [], isLoading: false, complete: true };
const EMPTY_STATE_ATOM = Atom.make(EMPTY_STATE).pipe(Atom.withLabel("web:session-search:empty"));

/**
 * One search per environment. An idle TTL of zero drops a superseded query's
 * atom as soon as nothing reads it, which interrupts its request on the server.
 */
const sessionSearchQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:session-search",
  tag: SESSION_SEARCH_WS_METHODS.search,
  staleTimeMs: 30_000,
  idleTtlMs: 0,
});

/** Failed or unsupported environments (older servers) contribute nothing. */
const sessionSearchResults = Atom.family((query: string) =>
  Atom.make((get): SessionSearchState => {
    const environmentIds = get(environmentSummaries.connectedEnvironmentIdsAtom);
    const found: Array<{ environmentId: EnvironmentId; hits: ReadonlyArray<SessionSearchHit> }> =
      [];
    let isLoading = false;
    let complete = true;
    for (const environmentId of environmentIds) {
      const result = get(sessionSearchQuery({ environmentId, input: { query } }));
      isLoading ||= result.waiting;
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value === null) continue;
      complete &&= value.complete;
      if (value.sessions.length > 0) found.push({ environmentId, hits: value.sessions });
    }
    const labels =
      found.length > 1
        ? new Map(
            get(environmentSummaries.identitiesAtom).map(
              (identity) => [identity.environmentId, identity.label] as const,
            ),
          )
        : null;
    const entries = found
      .flatMap(({ environmentId, hits }) =>
        hits.map((hit) => ({
          environmentId,
          environmentLabel: labels?.get(environmentId) ?? null,
          hit,
        })),
      )
      .sort((a, b) => Date.parse(b.hit.updatedAt) - Date.parse(a.hit.updatedAt));
    return { entries, isLoading, complete };
  }).pipe(Atom.withLabel(`web:session-search:${query}`)),
);

/** Debounced search for the sidebar query; nothing runs below two characters. */
export function useSessionSearch(query: string): SessionSearchState & {
  readonly isPending: boolean;
} {
  const normalized = query.trim();
  const debounced = useDebouncedValue(normalized, DEBOUNCE_MS);
  const canSearch = normalized.length >= MIN_QUERY_LENGTH;
  const settled = canSearch && normalized === debounced ? debounced : null;
  const state = useAtomValue(settled === null ? EMPTY_STATE_ATOM : sessionSearchResults(settled));
  const isDebouncing = canSearch && settled === null;
  return {
    ...(isDebouncing ? EMPTY_STATE : state),
    isPending: canSearch && (isDebouncing || state.isLoading),
  };
}
