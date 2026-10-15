import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProviderThreadId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * What a thread's provider session reports about itself beyond the usage the
 * projection already stores: the per-category context breakdown and the MCP
 * servers the provider's own client is connected to. Read on demand from the
 * live session, so a client asks only while it is showing them.
 */
export const SessionInsightsInput = Schema.Struct({
  threadId: ThreadId,
});
export type SessionInsightsInput = typeof SessionInsightsInput.Type;

/**
 * `used` rows occupy the window, `free` is what remains, `buffer` is the
 * compaction reserve, and `deferred` rows (tool schemas loaded on demand) are
 * listed for awareness but sit outside the window.
 */
export const SessionContextCategoryKind = Schema.Literals(["used", "free", "buffer", "deferred"]);
export type SessionContextCategoryKind = typeof SessionContextCategoryKind.Type;

export const SessionContextCategory = Schema.Struct({
  name: TrimmedNonEmptyString,
  tokens: NonNegativeInt,
  kind: SessionContextCategoryKind,
});
export type SessionContextCategory = typeof SessionContextCategory.Type;

/** One contributor inside a category, such as a memory file or an MCP tool. */
export const SessionContextContributor = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** Where it comes from: the MCP server, the memory file's scope, the skill's plugin. */
  source: Schema.optional(TrimmedNonEmptyString),
  /**
   * Absent when the source can name the contributor but not size it, such as
   * a memory file listed in another agent's transcript.
   */
  tokens: Schema.optional(NonNegativeInt),
});
export type SessionContextContributor = typeof SessionContextContributor.Type;

export const SessionContextBreakdown = Schema.Struct({
  model: Schema.optional(TrimmedNonEmptyString),
  totalTokens: NonNegativeInt,
  /** The window usage is measured against, which may be a compaction window. */
  maxTokens: NonNegativeInt,
  categories: Schema.Array(SessionContextCategory),
  mcpTools: Schema.Array(SessionContextContributor),
  memoryFiles: Schema.Array(SessionContextContributor),
  agents: Schema.Array(SessionContextContributor),
  skills: Schema.Array(SessionContextContributor),
  /** The provider reported no breakdown, so these counts are estimated from the transcript. */
  estimated: Schema.optional(Schema.Boolean),
  /** What the estimate leaves out, shown under the breakdown. */
  note: Schema.optional(TrimmedNonEmptyString),
  /** Whether the agent compacts on its own when usage reaches the threshold. */
  autoCompactEnabled: Schema.optional(Schema.Boolean),
  /** Tokens in context at which the agent compacts on its own. */
  autoCompactThreshold: Schema.optional(NonNegativeInt),
  /** Times the session's context has been compacted so far. */
  compactionCount: Schema.optional(NonNegativeInt),
});
export type SessionContextBreakdown = typeof SessionContextBreakdown.Type;

export const SessionMcpServerStatus = Schema.Literals([
  "connected",
  "pending",
  "needs-auth",
  "failed",
  "disabled",
  /** Listed in the agent's configuration; it does not report whether it connected. */
  "configured",
]);
export type SessionMcpServerStatus = typeof SessionMcpServerStatus.Type;

export const SessionMcpServer = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: SessionMcpServerStatus,
  error: Schema.optional(Schema.String),
  version: Schema.optional(TrimmedNonEmptyString),
  toolCount: Schema.optional(NonNegativeInt),
});
export type SessionMcpServer = typeof SessionMcpServer.Type;

/**
 * What an agent that keeps its own session store says about the session, for
 * providers whose sessions T3 does not run itself (Hermes). Every field is
 * optional: a store reports what it records.
 */
/** One plan usage limit the agent reports, such as a 5-hour or weekly window. */
export const SessionRateLimit = Schema.Struct({
  /** "5-hour", "Weekly", or the agent's own name for the window. */
  name: TrimmedNonEmptyString,
  usedPercent: Schema.Number,
  resetsAt: Schema.optional(IsoDateTime),
});
export type SessionRateLimit = typeof SessionRateLimit.Type;

export const SessionRecord = Schema.Struct({
  /** Where the session came from in the agent: its CLI, a gateway, an API client. */
  source: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  /** `idle`: not ended, but inactive for a while. */
  status: Schema.optional(Schema.Literals(["active", "idle", "ended"])),
  endReason: Schema.optional(TrimmedNonEmptyString),
  startedAt: Schema.optional(IsoDateTime),
  lastActiveAt: Schema.optional(IsoDateTime),
  endedAt: Schema.optional(IsoDateTime),
  messageCount: Schema.optional(NonNegativeInt),
  toolCallCount: Schema.optional(NonNegativeInt),
  apiCallCount: Schema.optional(NonNegativeInt),
  costUsd: Schema.optional(Schema.Number),
  /** The agent priced the session from list prices rather than a billed amount. */
  costEstimated: Schema.optional(Schema.Boolean),
  inputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  cacheReadTokens: Schema.optional(NonNegativeInt),
  cacheWriteTokens: Schema.optional(NonNegativeInt),
  reasoningTokens: Schema.optional(NonNegativeInt),
  /** Version of the agent's CLI or app that last wrote the session. */
  version: Schema.optional(TrimmedNonEmptyString),
  /** Reasoning effort or thinking level, in the agent's own terms. */
  effort: Schema.optional(TrimmedNonEmptyString),
  /** Approval or permission mode, in the agent's own terms. */
  permissionMode: Schema.optional(TrimmedNonEmptyString),
  sandbox: Schema.optional(TrimmedNonEmptyString),
  /** The session can be steered from another device (Claude Remote Control). */
  remoteControl: Schema.optional(Schema.Boolean),
  /** Speed tier, e.g. Codex's "fast" or "standard". */
  serviceTier: Schema.optional(TrimmedNonEmptyString),
  turnCount: Schema.optional(NonNegativeInt),
  /** Agent steps, for agents that count steps instead of messages. */
  stepCount: Schema.optional(NonNegativeInt),
  toolFailureCount: Schema.optional(NonNegativeInt),
  /** Wall time the agent spent working, summed over turns. */
  durationMs: Schema.optional(NonNegativeInt),
  rateLimits: Schema.optional(Schema.Array(SessionRateLimit)),
});
export type SessionRecord = typeof SessionRecord.Type;

/** One file a session changed, read from the agent's own record of its edits. */
export const SessionOutputFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  /** False when the record names the file but not the lines changed. */
  hasStats: Schema.Boolean,
});
export type SessionOutputFile = typeof SessionOutputFile.Type;

export const SessionInsights = Schema.Struct({
  providerThreadId: ProviderThreadId,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  /** Whether a provider session is running for the thread right now. */
  live: Schema.Boolean,
  /** When the reported details were read; older than now when `live` is false. */
  capturedAt: Schema.NullOr(IsoDateTime),
  /** Null when the provider does not report a breakdown. */
  context: Schema.NullOr(SessionContextBreakdown),
  /** Null when the provider does not report its MCP servers. */
  mcpServers: Schema.NullOr(Schema.Array(SessionMcpServer)),
  /** The name of the machine the server runs on. */
  host: Schema.optional(TrimmedNonEmptyString),
  /** Present when the agent keeps its own session store and reported it. */
  session: Schema.optional(SessionRecord),
  /** The files the agent's store says it changed, for agents whose edits T3 has no turn diff of. */
  outputs: Schema.optional(Schema.NullOr(Schema.Array(SessionOutputFile))),
});
export type SessionInsights = typeof SessionInsights.Type;

export const SessionInsightsErrorReason = Schema.Literals(["no-provider-thread", "request-failed"]);
export type SessionInsightsErrorReason = typeof SessionInsightsErrorReason.Type;

export class SessionInsightsError extends Schema.TaggedError<SessionInsightsError>()(
  "SessionInsightsError",
  {
    threadId: ThreadId,
    reason: SessionInsightsErrorReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "no-provider-thread":
        return "This thread has not started a provider session yet.";
      case "request-failed":
        return "Could not read the session details.";
    }
  }
}
