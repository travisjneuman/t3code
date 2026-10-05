/**
 * Compare agents: one prompt sent to two agents as two new threads in the
 * same project (or "No project", where each side gets a folder of its own),
 * shown side by side. "Review swap" then sends each agent the
 * other's latest final answer, saying which provider, model and options
 * produced it for the same prompts. "Follow up" sends one message to both and
 * "Stop" interrupts both. The pair needs no stored record: both
 * thread ids derive from the pair id. Fork add-on; see
 * docs/user/compare-agents.md.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { AuthOrchestrationOperateScope, EnvironmentAuthorizationError } from "./auth.ts";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const COMPARE_AGENTS_WS_METHODS = {
  start: "compareAgents.start",
  reviewSwap: "compareAgents.reviewSwap",
  followUp: "compareAgents.followUp",
  stop: "compareAgents.stop",
} as const;

/** Message id prefixes of what Compare agents sends, so clients can label each prompt. */
export const COMPARE_REVIEW_MESSAGE_PREFIX = "compare-agents-review:";
export const COMPARE_FOLLOW_UP_MESSAGE_PREFIX = "compare-agents-follow-up:";

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
  /** Absent for "No project": the environment's Scratch project. */
  projectId: Schema.optional(ProjectId),
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

/** Success of the calls that only send: review swap, follow-up, and stop. */
export const CompareAgentsEmptyResult = Schema.Struct({});
export type CompareAgentsEmptyResult = typeof CompareAgentsEmptyResult.Type;

/** One side of a follow-up: its model for this turn and its own attachment uploads. */
export const CompareAgentsFollowUpSide = Schema.Struct({
  modelSelection: ModelSelection,
  attachments: Schema.Array(ChatAttachment),
});
export type CompareAgentsFollowUpSide = typeof CompareAgentsFollowUpSide.Type;

/** The same text and modes to both sides; attachments upload once per side. */
export const CompareAgentsFollowUpInput = Schema.Struct({
  pairId: ComparePairId,
  text: TrimmedNonEmptyString,
  interactionMode: ProviderInteractionMode,
  runtimeMode: RuntimeMode,
  left: CompareAgentsFollowUpSide,
  right: CompareAgentsFollowUpSide,
});
export type CompareAgentsFollowUpInput = typeof CompareAgentsFollowUpInput.Type;

export const CompareAgentsStopInput = Schema.Struct({
  pairId: ComparePairId,
});
export type CompareAgentsStopInput = typeof CompareAgentsStopInput.Type;

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
  success: CompareAgentsEmptyResult,
  error: CompareAgentsRpcError,
});

export const CompareAgentsFollowUpRpc = Rpc.make(COMPARE_AGENTS_WS_METHODS.followUp, {
  payload: CompareAgentsFollowUpInput,
  success: CompareAgentsEmptyResult,
  error: CompareAgentsRpcError,
});

export const CompareAgentsStopRpc = Rpc.make(COMPARE_AGENTS_WS_METHODS.stop, {
  payload: CompareAgentsStopInput,
  success: CompareAgentsEmptyResult,
  error: CompareAgentsRpcError,
});

export const CompareAgentsRpcs = [
  CompareAgentsStartRpc,
  CompareAgentsReviewSwapRpc,
  CompareAgentsFollowUpRpc,
  CompareAgentsStopRpc,
] as const;

/** The scope each RPC needs, spread into the server's `RPC_REQUIRED_SCOPES`. */
export const COMPARE_AGENTS_RPC_SCOPES = {
  [COMPARE_AGENTS_WS_METHODS.start]: AuthOrchestrationOperateScope,
  [COMPARE_AGENTS_WS_METHODS.reviewSwap]: AuthOrchestrationOperateScope,
  [COMPARE_AGENTS_WS_METHODS.followUp]: AuthOrchestrationOperateScope,
  [COMPARE_AGENTS_WS_METHODS.stop]: AuthOrchestrationOperateScope,
} as const;
