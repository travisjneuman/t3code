import { useAtomValue } from "@effect/atom-react";
import {
  arrayElementsEqual,
  parseThreadKey,
  threadKey,
} from "@t3tools/client-runtime/state/entities";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import {
  deriveSessionInsightsRefreshKey,
  deriveThreadOutputs,
  deriveThreadSessionSummary,
  selectFileChangeItems,
  threadSessionSummaryEqual,
  type ThreadOutputFile,
  type ThreadSessionSummary,
} from "../components/chat/sessionInsights.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { environmentThreadDetails } from "./threads";

/**
 * Session details for the thread details card: the provider's context
 * breakdown and MCP servers over RPC, plus summaries derived from the thread
 * projection. Fork add-on.
 */

const projectionAtom = (key: string) => environmentThreadDetails.stateAtom(parseThreadKey(key));

// A string that moves only when a turn settles or the session changes state,
// so streaming deltas never refetch the breakdown.
const refreshKeyAtomFamily = Atom.family((key: string) =>
  Atom.make((get) =>
    deriveSessionInsightsRefreshKey(Option.getOrNull(get(projectionAtom(key)).data)),
  ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`web-session-insights-refresh:${key}`)),
);

export const sessionInsightsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:session-insights:get",
  tag: WS_METHODS.sessionInsightsGet,
  refreshTrigger: ({ environmentId, input }) =>
    refreshKeyAtomFamily(threadKey(scopeThreadRef(environmentId, input.threadId))),
});

/** Reads the provider's session details while `ref` is set; null stops fetching. */
export function useSessionInsights(ref: ScopedThreadRef | null) {
  return useEnvironmentQuery(
    ref === null
      ? null
      : sessionInsightsQuery({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId },
        }),
  );
}

const sessionSummaryAtomFamily = Atom.family((key: string) => {
  let previous: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "providerSessions" | "providerThreads"
  > | null = null;
  let value: ThreadSessionSummary | null = null;
  return Atom.make((get) => {
    const projection = Option.getOrNull(get(projectionAtom(key)).data);
    if (projection === null) {
      previous = null;
      value = null;
      return value;
    }
    if (
      previous !== null &&
      projection.thread === previous.thread &&
      projection.runs === previous.runs &&
      projection.providerSessions === previous.providerSessions &&
      projection.providerThreads === previous.providerThreads
    ) {
      return value;
    }
    const { thread, runs, providerSessions, providerThreads } = projection;
    previous = { thread, runs, providerSessions, providerThreads };
    const next = deriveThreadSessionSummary(projection);
    if (value === null || !threadSessionSummaryEqual(value, next)) value = next;
    return value;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`web-thread-session-summary:${key}`));
});

export function useThreadSessionSummary(ref: ScopedThreadRef): ThreadSessionSummary | null {
  return useAtomValue(sessionSummaryAtomFamily(threadKey(ref)));
}

const EMPTY_OUTPUTS: ReadonlyArray<ThreadOutputFile> = [];

const outputsAtomFamily = Atom.family((key: string) => {
  let previousTurnItems: OrchestrationV2ThreadProjection["turnItems"] | null = null;
  let previousItems: ReturnType<typeof selectFileChangeItems> = [];
  let value = EMPTY_OUTPUTS;
  return Atom.make((get) => {
    const turnItems = Option.getOrNull(get(projectionAtom(key)).data)?.turnItems ?? null;
    if (turnItems === previousTurnItems) return value;
    previousTurnItems = turnItems;
    // Items update in place while text streams; only file changes matter here.
    const items = turnItems === null ? [] : selectFileChangeItems(turnItems);
    if (arrayElementsEqual(items, previousItems)) return value;
    previousItems = items;
    value = items.length === 0 ? EMPTY_OUTPUTS : deriveThreadOutputs(items);
    return value;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`web-thread-outputs:${key}`));
});

export function useThreadOutputs(ref: ScopedThreadRef): ReadonlyArray<ThreadOutputFile> {
  return useAtomValue(outputsAtomFamily(threadKey(ref)));
}
