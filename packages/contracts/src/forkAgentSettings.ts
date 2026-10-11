// Fork add-on: agent instructions. Value types for the Settings, General,
// Agents rows. The server turns these settings into the instructions every
// provider receives; see docs/user/agent-instructions.md.
import * as Schema from "effect/Schema";

/**
 * How the thread's agent hands out work through `delegate_task`. `off` adds no
 * delegation rules, `auto` delegates independent pieces and keeps small work,
 * `always` keeps the agent to planning, review and integration.
 */
export const AgentDelegationMode = Schema.Literals(["off", "auto", "always"]);
export type AgentDelegationMode = typeof AgentDelegationMode.Type;

export const MIN_AGENT_PARALLEL_WORKERS = 1;
export const MAX_AGENT_PARALLEL_WORKERS = 12;
export const AgentMaxParallelWorkers = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_AGENT_PARALLEL_WORKERS,
    maximum: MAX_AGENT_PARALLEL_WORKERS,
  }),
);
export type AgentMaxParallelWorkers = typeof AgentMaxParallelWorkers.Type;
