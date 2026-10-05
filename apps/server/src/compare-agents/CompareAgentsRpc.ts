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

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import * as CompareAgents from "./CompareAgents.ts";

const traceAttributes = { "rpc.aggregate": "compareAgents" };

export const makeHandlers = Effect.gen(function* () {
  const compareAgents = yield* CompareAgents.CompareAgents;
  return {
    [COMPARE_AGENTS_WS_METHODS.start]: (input: CompareAgentsStartInput) =>
      observeRpcEffect(
        COMPARE_AGENTS_WS_METHODS.start,
        compareAgents.start(input),
        traceAttributes,
      ),
    [COMPARE_AGENTS_WS_METHODS.reviewSwap]: (input: CompareAgentsReviewSwapInput) =>
      observeRpcEffect(
        COMPARE_AGENTS_WS_METHODS.reviewSwap,
        compareAgents.reviewSwap(input),
        traceAttributes,
      ),
    [COMPARE_AGENTS_WS_METHODS.followUp]: (input: CompareAgentsFollowUpInput) =>
      observeRpcEffect(
        COMPARE_AGENTS_WS_METHODS.followUp,
        compareAgents.followUp(input),
        traceAttributes,
      ),
    [COMPARE_AGENTS_WS_METHODS.stop]: (input: CompareAgentsStopInput) =>
      observeRpcEffect(COMPARE_AGENTS_WS_METHODS.stop, compareAgents.stop(input), traceAttributes),
  };
}).pipe(Effect.provide(CompareAgents.layer));
