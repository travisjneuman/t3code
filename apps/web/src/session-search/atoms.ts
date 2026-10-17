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
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSummaries } from "../state/presentation";
import { useDebouncedValue } from "../state/queries";

// Each search reads transcripts on the server, so wait a little longer than thread search.
const DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

export interface SessionSearchEntry {
  readonly environmentId: EnvironmentId;
  /** Set only when more than one environment is connected. */
  readonly environmentLabel: string | null;
  readonly hit: SessionSearchHit;
}

interface SessionSearchState {
  readonly entries: ReadonlyArray<SessionSearchEntry>;
  readonly isLoading: boolean;
  /** False when a server stopped at its time budget, so older matches may be missing. */
  readonly complete: boolean;
  /** Connected environments the search went to. */
  readonly searchedHosts: number;
  /** Environments that returned a result, with or without matches. */
  readonly answeredHosts: number;
  /** Labels of environments whose search failed; one still loading is not listed. */
  readonly failedHostLabels: ReadonlyArray<string>;
}

const EMPTY_STATE: SessionSearchState = {
  entries: [],
  isLoading: false,
  complete: true,
  searchedHosts: 0,
  answeredHosts: 0,
  failedHostLabels: [],
};
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

/**
 * Failed environments (timeouts, disconnects, older servers without the
 * method) contribute no hits but are named, so a missing host is visible.
 */
const sessionSearchResults = Atom.family((query: string) =>
  Atom.make((get): SessionSearchState => {
    const environmentIds = get(environmentSummaries.connectedEnvironmentIdsAtom);
    const found: Array<{ environmentId: EnvironmentId; hits: ReadonlyArray<SessionSearchHit> }> =
      [];
    const failedIds: Array<EnvironmentId> = [];
    let isLoading = false;
    let complete = true;
    let answeredHosts = 0;
    for (const environmentId of environmentIds) {
      const result = get(sessionSearchQuery({ environmentId, input: { query } }));
      isLoading ||= result.waiting;
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value === null) {
        // A superseded request is interrupted, not failed; a waiting failure is retrying.
        if (
          AsyncResult.isFailure(result) &&
          !result.waiting &&
          !AsyncResult.isInterrupted(result)
        ) {
          failedIds.push(environmentId);
        }
        continue;
      }
      answeredHosts += 1;
      complete &&= value.complete;
      if (value.sessions.length > 0) found.push({ environmentId, hits: value.sessions });
    }
    const labels =
      environmentIds.length > 1 || failedIds.length > 0
        ? new Map(
            get(environmentSummaries.identitiesAtom).map(
              (identity) => [identity.environmentId, identity.label] as const,
            ),
          )
        : null;
    const rowLabels = environmentIds.length > 1 ? labels : null;
    const entries = found
      .flatMap(({ environmentId, hits }) =>
        hits.map((hit) => ({
          environmentId,
          environmentLabel: rowLabels?.get(environmentId) ?? null,
          hit,
        })),
      )
      .sort((a, b) => Date.parse(b.hit.updatedAt) - Date.parse(a.hit.updatedAt));
    const failedHostLabels = failedIds.map(
      (environmentId) => labels?.get(environmentId) ?? "A host",
    );
    return {
      entries,
      isLoading,
      complete,
      searchedHosts: environmentIds.length,
      answeredHosts,
      failedHostLabels,
    };
  }).pipe(Atom.withLabel(`web:session-search:${query}`)),
);

const hostList = new Intl.ListFormat("en", { type: "conjunction" });

/** "Studio didn't answer", "Studio and Office didn't answer". */
export function failedHostsSummary(labels: ReadonlyArray<string>): string {
  return `${hostList.format(labels)} didn't answer`;
}

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
