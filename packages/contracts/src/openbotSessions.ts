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
  newChat: "openbotSessions.newChat",
  setAgent: "openbotSessions.setAgent",
} as const;

export const OpenBotConversationSummary = Schema.Struct({
  /** OpenBot's thread id. */
  id: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  agentName: Schema.String,
  /** The agent's role in OpenBot, if it has one. */
  agentTitle: Schema.optional(Schema.String),
  title: Schema.String,
  /** A side thread, shown under its agent's main conversation. */
  side: Schema.optional(Schema.Boolean),
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

const MINOR_ROLE_WORDS = new Set(["of", "and", "the", "for", "to", "in"]);

/** A role of two or more words as its initials, minor words in lower case: "Chief of Staff" is "CoS". */
const abbreviateOpenBotRole = (role: string) => {
  const words = role.trim().split(/\s+/);
  if (words.length < 2) return role.trim();
  return words
    .filter((word) => word !== "&")
    .map((word) => {
      const initial = word.charAt(0);
      return MINOR_ROLE_WORDS.has(word.toLowerCase())
        ? initial.toLowerCase()
        : initial.toUpperCase();
    })
    .join("");
};

/** "Name - Role" with the role abbreviated, or the name alone when the agent has no role. */
export const openBotAgentLabel = (name: string, role: string | undefined) =>
  role?.trim() ? `${name} - ${abbreviateOpenBotRole(role)}` : name;

/** A T3 thread for a new chat, and whether a thread id is one. */
export const openBotNewChatThreadId = (instanceId: string, chatId: string) =>
  `openbot:${instanceId}:new-chat:${chatId}`;
export const isOpenBotNewChatThread = (threadId: string) =>
  threadId.startsWith("openbot:") && threadId.includes(":new-chat:");

export const OpenBotAgentSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  title: Schema.optional(Schema.String),
  /** Local scripts is on, so T3 can message it. */
  sendable: Schema.Boolean,
});
export type OpenBotAgentSummary = typeof OpenBotAgentSummary.Type;

/** A new chat's thread before its first message, while its agent can still change. */
export const OpenBotPendingChat = Schema.Struct({
  threadId: ThreadId,
  agentId: TrimmedNonEmptyString,
});
export type OpenBotPendingChat = typeof OpenBotPendingChat.Type;

export const OpenBotSessionsListInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type OpenBotSessionsListInput = typeof OpenBotSessionsListInput.Type;

export const OpenBotSessionsListResult = Schema.Struct({
  /** The section title: the instance's own name, else where OpenBot runs. */
  label: Schema.optional(Schema.String),
  /** Newest first. */
  conversations: Schema.Array(OpenBotConversationSummary),
  /** Every agent, in OpenBot's order. */
  agents: Schema.optional(Schema.Array(OpenBotAgentSummary)),
  pendingChats: Schema.optional(Schema.Array(OpenBotPendingChat)),
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

/**
 * A new chat's thread, with the instance's default agent unless `agentId` names one. Its first
 * message starts the fresh chat in OpenBot; until then its agent can change.
 */
export const OpenBotSessionsNewChatInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  agentId: Schema.optional(TrimmedNonEmptyString),
});
export type OpenBotSessionsNewChatInput = typeof OpenBotSessionsNewChatInput.Type;

export const OpenBotSessionsSetAgentInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
  agentId: TrimmedNonEmptyString,
});
export type OpenBotSessionsSetAgentInput = typeof OpenBotSessionsSetAgentInput.Type;

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

export const OpenBotSessionsNewChatRpc = Rpc.make(OPENBOT_SESSIONS_WS_METHODS.newChat, {
  payload: OpenBotSessionsNewChatInput,
  success: OpenBotSessionsOpenResult,
  error: OpenBotSessionsRpcError,
});

export const OpenBotSessionsSetAgentRpc = Rpc.make(OPENBOT_SESSIONS_WS_METHODS.setAgent, {
  payload: OpenBotSessionsSetAgentInput,
  success: OpenBotSessionsOpenResult,
  error: OpenBotSessionsRpcError,
});

export const OpenBotSessionsRpcs = [
  OpenBotSessionsListRpc,
  OpenBotSessionsOpenRpc,
  OpenBotSessionsNewChatRpc,
  OpenBotSessionsSetAgentRpc,
] as const;

/** The scope each RPC needs, spread into the server's `RPC_REQUIRED_SCOPES`. */
export const OPENBOT_SESSIONS_RPC_SCOPES = {
  [OPENBOT_SESSIONS_WS_METHODS.list]: AuthOrchestrationReadScope,
  [OPENBOT_SESSIONS_WS_METHODS.open]: AuthOrchestrationOperateScope,
  [OPENBOT_SESSIONS_WS_METHODS.newChat]: AuthOrchestrationOperateScope,
  [OPENBOT_SESSIONS_WS_METHODS.setAgent]: AuthOrchestrationOperateScope,
} as const;
