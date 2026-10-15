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
  tokens: NonNegativeInt,
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
export const SessionRecord = Schema.Struct({
  /** Where the session came from in the agent: its CLI, a gateway, an API client. */
  source: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  status: Schema.optional(Schema.Literals(["active", "ended"])),
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
});
export type SessionRecord = typeof SessionRecord.Type;

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
