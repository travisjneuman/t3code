/**
 * Compare agents: one prompt sent to two agents as two new threads in the
 * same project, shown side by side. "Review swap" then sends each agent the
 * other's latest final answer, saying which provider, model and options
 * produced it for the same prompt. The pair needs no stored record: both
 * thread ids derive from the pair id. Fork add-on; see
 * docs/user/compare-agents.md.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { AuthOrchestrationOperateScope, EnvironmentAuthorizationError } from "./auth.ts";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const COMPARE_AGENTS_WS_METHODS = {
  start: "compareAgents.start",
  reviewSwap: "compareAgents.reviewSwap",
} as const;

const PAIR_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMPARE_THREAD_ID_PATTERN = /^compare:([0-9a-f-]{36}):([ab])$/;

export const ComparePairId = TrimmedNonEmptyString.check(Schema.isPattern(PAIR_ID_PATTERN));
export type ComparePairId = typeof ComparePairId.Type;

export type CompareSide = "a" | "b";

/** The two threads of a pair, left ("a") then right ("b"). */
export const compareThreadIds = (pairId: string): readonly [ThreadId, ThreadId] => [
  ThreadId.make(`compare:${pairId}:a`),
  ThreadId.make(`compare:${pairId}:b`),
];

/** The pair a thread belongs to, or null for a thread Compare agents did not start. */
export const comparePairOf = (
  threadId: string,
): { readonly pairId: string; readonly side: CompareSide } | null => {
  const match = COMPARE_THREAD_ID_PATTERN.exec(threadId);
  if (match === null || !PAIR_ID_PATTERN.test(match[1]!)) return null;
  return { pairId: match[1]!, side: match[2] === "a" ? "a" : "b" };
};

export const CompareAgentsStartInput = Schema.Struct({
  projectId: ProjectId,
  prompt: TrimmedNonEmptyString,
  left: ModelSelection,
  right: ModelSelection,
});
export type CompareAgentsStartInput = typeof CompareAgentsStartInput.Type;

export const CompareAgentsStartResult = Schema.Struct({
  pairId: ComparePairId,
});
export type CompareAgentsStartResult = typeof CompareAgentsStartResult.Type;

export const CompareAgentsReviewSwapInput = Schema.Struct({
  pairId: ComparePairId,
});
export type CompareAgentsReviewSwapInput = typeof CompareAgentsReviewSwapInput.Type;

export const CompareAgentsReviewSwapResult = Schema.Struct({});
export type CompareAgentsReviewSwapResult = typeof CompareAgentsReviewSwapResult.Type;

export class CompareAgentsError extends Schema.TaggedError<CompareAgentsError>()(
  "CompareAgentsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const CompareAgentsRpcError = Schema.Union([CompareAgentsError, EnvironmentAuthorizationError]);

export const CompareAgentsStartRpc = Rpc.make(COMPARE_AGENTS_WS_METHODS.start, {
  payload: CompareAgentsStartInput,
  success: CompareAgentsStartResult,
  error: CompareAgentsRpcError,
});

export const CompareAgentsReviewSwapRpc = Rpc.make(COMPARE_AGENTS_WS_METHODS.reviewSwap, {
  payload: CompareAgentsReviewSwapInput,
  success: CompareAgentsReviewSwapResult,
  error: CompareAgentsRpcError,
});

export const CompareAgentsRpcs = [CompareAgentsStartRpc, CompareAgentsReviewSwapRpc] as const;

/** The scope each RPC needs, spread into the server's `RPC_REQUIRED_SCOPES`. */
export const COMPARE_AGENTS_RPC_SCOPES = {
  [COMPARE_AGENTS_WS_METHODS.start]: AuthOrchestrationOperateScope,
  [COMPARE_AGENTS_WS_METHODS.reviewSwap]: AuthOrchestrationOperateScope,
} as const;
