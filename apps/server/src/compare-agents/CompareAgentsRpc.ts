/**
 * WebSocket handlers for Compare agents: each calls one CompareAgents method.
 * Fork add-on: compare agents.
 *
 * @module compare-agents/CompareAgentsRpc
 */
import {
  COMPARE_AGENTS_WS_METHODS,
  type CompareAgentsFollowUpInput,
  type CompareAgentsReviewSwapInput,
  type CompareAgentsStartInput,
  type CompareAgentsStopInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CompareAgents from "./CompareAgents.ts";

export const makeHandlers = Effect.gen(function* () {
  const compareAgents = yield* CompareAgents.CompareAgents;
  return {
    [COMPARE_AGENTS_WS_METHODS.start]: (input: CompareAgentsStartInput) =>
      compareAgents.start(input),
    [COMPARE_AGENTS_WS_METHODS.reviewSwap]: (input: CompareAgentsReviewSwapInput) =>
      compareAgents.reviewSwap(input),
    [COMPARE_AGENTS_WS_METHODS.followUp]: (input: CompareAgentsFollowUpInput) =>
      compareAgents.followUp(input),
    [COMPARE_AGENTS_WS_METHODS.stop]: (input: CompareAgentsStopInput) =>
      compareAgents.stop(input),
  };
}).pipe(Effect.provide(CompareAgents.layer));
