/**
 * The sidebar's OpenBot section lists every OpenBot agent's conversations, read from OpenBot's
 * database, and opens one as a Scratch thread. Only an agent's main conversation, with Local
 * scripts on, takes messages; the rest are watch-only. Fork add-on; see docs/user/openbot.md.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const OPENBOT_SESSIONS_WS_METHODS = {
  list: "openbotSessions.list",
  open: "openbotSessions.open",
} as const;

export const OpenBotConversationSummary = Schema.Struct({
  /** OpenBot's thread id. */
  id: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  agentName: Schema.String,
  title: Schema.String,
  /** False for side threads and agents without Local scripts: T3 can show them, not message them. */
  sendable: Schema.Boolean,
  /** OpenBot is working in it right now. */
  running: Schema.Boolean,
  /** Epoch milliseconds. */
  lastActiveAt: Schema.Number,
  messageCount: Schema.Number,
  /** The T3 thread already bound to this conversation, if any. */
  threadId: Schema.NullOr(ThreadId),
});
export type OpenBotConversationSummary = typeof OpenBotConversationSummary.Type;

export const OpenBotSessionsListInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type OpenBotSessionsListInput = typeof OpenBotSessionsListInput.Type;

export const OpenBotSessionsListResult = Schema.Struct({
  /** Newest first. */
  conversations: Schema.Array(OpenBotConversationSummary),
});
export type OpenBotSessionsListResult = typeof OpenBotSessionsListResult.Type;

export const OpenBotSessionsOpenInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  conversationId: TrimmedNonEmptyString,
});
export type OpenBotSessionsOpenInput = typeof OpenBotSessionsOpenInput.Type;

export const OpenBotSessionsOpenResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
});
export type OpenBotSessionsOpenResult = typeof OpenBotSessionsOpenResult.Type;

export class OpenBotSessionsError extends Schema.TaggedError<OpenBotSessionsError>()(
  "OpenBotSessionsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const OpenBotSessionsRpcError = Schema.Union([OpenBotSessionsError, EnvironmentAuthorizationError]);

export const OpenBotSessionsListRpc = Rpc.make(OPENBOT_SESSIONS_WS_METHODS.list, {
  payload: OpenBotSessionsListInput,
  success: OpenBotSessionsListResult,
  error: OpenBotSessionsRpcError,
});

export const OpenBotSessionsOpenRpc = Rpc.make(OPENBOT_SESSIONS_WS_METHODS.open, {
  payload: OpenBotSessionsOpenInput,
  success: OpenBotSessionsOpenResult,
  error: OpenBotSessionsRpcError,
});

export const OpenBotSessionsRpcs = [OpenBotSessionsListRpc, OpenBotSessionsOpenRpc] as const;

/** The scope each RPC needs, spread into the server's `RPC_REQUIRED_SCOPES`. */
export const OPENBOT_SESSIONS_RPC_SCOPES = {
  [OPENBOT_SESSIONS_WS_METHODS.list]: AuthOrchestrationReadScope,
  [OPENBOT_SESSIONS_WS_METHODS.open]: AuthOrchestrationOperateScope,
} as const;
