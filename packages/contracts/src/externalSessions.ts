/**
 * External sessions: live views of agent sessions that run outside T3
 * (Claude Code, Codex, Grok, Pi, Antigravity CLIs and desktop apps), found in
 * each provider's own on-disk session store, and continuing an idle one as a
 * T3 thread. Fork add-on; see docs/internals/external-sessions.md.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const EXTERNAL_SESSIONS_WS_METHODS = {
  subscribeList: "externalSessions.subscribeList",
  subscribeSession: "externalSessions.subscribeSession",
  continue: "externalSessions.continue",
  subscribeRunningElsewhere: "externalSessions.subscribeRunningElsewhere",
} as const;

/** The streaming methods, for the client's subscription tag union. */
export type ExternalSessionsSubscriptionMethod =
  | typeof EXTERNAL_SESSIONS_WS_METHODS.subscribeList
  | typeof EXTERNAL_SESSIONS_WS_METHODS.subscribeSession
  | typeof EXTERNAL_SESSIONS_WS_METHODS.subscribeRunningElsewhere;

/**
 * running: written to in the last minute (or the provider reports it busy).
 * idle: touched within the last hour. recent: anything older still listed.
 */
export const ExternalSessionLiveness = Schema.Literals(["running", "idle", "recent"]);
export type ExternalSessionLiveness = typeof ExternalSessionLiveness.Type;

/**
 * What the agent's own store records about a session beyond its summary. Each
 * agent records a different subset, so everything but the id is optional.
 * Values that change during a session hold the latest one. Mode and effort
 * values are the agent's own terms ("xhigh", "bypassPermissions", "never").
 */
export const ExternalSessionDetails = Schema.Struct({
  /** The agent's own session id. */
  sessionId: Schema.String,
  /** Reasoning effort or thinking level. */
  effort: Schema.optional(Schema.String),
  /** Every git branch the session ran on, most recently used first. */
  gitBranches: Schema.optional(Schema.Array(Schema.String)),
  /** Version of the CLI or app that last wrote the session. */
  version: Schema.optional(Schema.String),
  /** Approval or permission mode. */
  approval: Schema.optional(Schema.String),
  /** Sandbox mode. */
  sandbox: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  /** Messages, as the agent counts them. */
  messageCount: Schema.optional(Schema.Number),
  /** Agent steps, for agents that count steps instead of messages. */
  stepCount: Schema.optional(Schema.Number),
  /** Tokens in context at the latest model request. */
  contextTokens: Schema.optional(Schema.Number),
  contextWindow: Schema.optional(Schema.Number),
  /** Tokens processed over the whole session, cached input included. */
  totalTokens: Schema.optional(Schema.Number),
});
export type ExternalSessionDetails = typeof ExternalSessionDetails.Type;

export const ExternalSessionSummary = Schema.Struct({
  /** Opaque, stable across restarts: `<driver>:<provider session id>`. */
  key: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  /** Where the session runs, e.g. "CLI", "Desktop", "VS Code"; null when unknown. */
  origin: Schema.NullOr(Schema.String),
  title: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  liveness: ExternalSessionLiveness,
  /**
   * Set only on a session stream's summaries. The list is pushed whole to
   * every subscriber on each change, so it leaves these out.
   */
  details: Schema.optional(ExternalSessionDetails),
});
export type ExternalSessionSummary = typeof ExternalSessionSummary.Type;

export const ExternalSessionListInput = Schema.Struct({});
export type ExternalSessionListInput = typeof ExternalSessionListInput.Type;

/** Newest first. The server sends a full list on subscribe and after every change. */
export const ExternalSessionListResult = Schema.Struct({
  sessions: Schema.Array(ExternalSessionSummary),
});
export type ExternalSessionListResult = typeof ExternalSessionListResult.Type;

export const ExternalSessionMessageRole = Schema.Literals(["user", "assistant", "tool"]);
export type ExternalSessionMessageRole = typeof ExternalSessionMessageRole.Type;

export const ExternalSessionMessage = Schema.Struct({
  id: Schema.String,
  role: ExternalSessionMessageRole,
  text: Schema.String,
  createdAt: Schema.String,
});
export type ExternalSessionMessage = typeof ExternalSessionMessage.Type;

export const ExternalSessionSubscribeInput = Schema.Struct({
  key: TrimmedNonEmptyString,
});
export type ExternalSessionSubscribeInput = typeof ExternalSessionSubscribeInput.Type;

/**
 * A session stream opens with a snapshot of its newest messages, then sends
 * appended messages and summary changes as the transcript grows. Appended
 * messages are upserted by id: a streamed reply grows in place.
 * `truncated` means older messages exist that the snapshot leaves out.
 */
export const ExternalSessionEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    summary: ExternalSessionSummary,
    messages: Schema.Array(ExternalSessionMessage),
    truncated: Schema.Boolean,
  }),
  Schema.TaggedStruct("append", {
    messages: Schema.Array(ExternalSessionMessage),
  }),
  Schema.TaggedStruct("summary", {
    summary: ExternalSessionSummary,
  }),
]);
export type ExternalSessionEvent = typeof ExternalSessionEvent.Type;

export class ExternalSessionError extends Schema.TaggedError<ExternalSessionError>()(
  "ExternalSessionError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const ExternalSessionRpcError = Schema.Union([ExternalSessionError, EnvironmentAuthorizationError]);

export const ExternalSessionContinueInput = Schema.Struct({
  key: TrimmedNonEmptyString,
  /**
   * Hand the history to this provider instance and model instead, for an agent
   * other than the session's. That makes a new T3 thread every time, carrying
   * the conversation as imported context; the original session stays unbound.
   */
  handoffTo: Schema.optional(
    Schema.Struct({ instanceId: ProviderInstanceId, model: TrimmedNonEmptyString }),
  ),
});
export type ExternalSessionContinueInput = typeof ExternalSessionContinueInput.Type;

/**
 * Continuing in place returns the T3 thread that owns the session, the same
 * one each time. A handoff returns the new thread it made.
 */
export const ExternalSessionContinueResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
});
export type ExternalSessionContinueResult = typeof ExternalSessionContinueResult.Type;

/**
 * Why a session cannot be continued in T3. `provider`: its runtime cannot
 * resume a session from disk here. `separate-store`: T3 runs this agent with
 * its own private session store, which cannot see the session. `no-folder`:
 * the session has no working folder. `folder-missing`: that folder no longer
 * exists. `no-instance`: no enabled provider instance reads this session
 * store. `too-large`: the transcript is too big to import. `empty`: nothing
 * to continue yet.
 */
export const ExternalSessionUnsupportedReason = Schema.Literals([
  "provider",
  "separate-store",
  "no-folder",
  "folder-missing",
  "no-instance",
  "too-large",
  "empty",
]);
export type ExternalSessionUnsupportedReason = typeof ExternalSessionUnsupportedReason.Type;

export const EXTERNAL_SESSION_UNSUPPORTED_MESSAGES: Record<
  ExternalSessionUnsupportedReason,
  string
> = {
  provider: "This provider's sessions can be watched here but not continued.",
  "separate-store":
    "T3 runs this agent with its own session store, so it cannot pick up this session here.",
  "no-folder": "This session has no working folder to open as a project.",
  "folder-missing": "This session's working folder no longer exists.",
  "no-instance": "No enabled provider in T3 reads this session's folder.",
  "too-large": "This session's transcript is too large to continue here.",
  empty: "This session has no messages to continue yet.",
};

const CONTINUABLE_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex", "grok", "pi"]);
// Antigravity in T3 keeps conversations in a private per-instance GEMINI_HOME.
const SEPARATE_STORE_DRIVERS: ReadonlySet<string> = new Set(["antigravity"]);

/**
 * What can be known from a summary alone. The server checks again, along
 * with the reasons only it can see.
 */
export function externalSessionUnsupportedReason(
  summary: Pick<ExternalSessionSummary, "driver" | "cwd">,
): ExternalSessionUnsupportedReason | null {
  if (SEPARATE_STORE_DRIVERS.has(summary.driver)) return "separate-store";
  if (!CONTINUABLE_DRIVERS.has(summary.driver)) return "provider";
  if (summary.cwd === null) return "no-folder";
  return null;
}

/**
 * Whether a summary's history can be handed to a different agent. Unlike
 * continuing in place, this only reads the transcript, so the agent's own
 * runtime and store layout do not matter. The server checks again.
 */
export function externalSessionHandoffUnsupportedReason(
  summary: Pick<ExternalSessionSummary, "driver" | "cwd">,
): ExternalSessionUnsupportedReason | null {
  if (!CONTINUABLE_DRIVERS.has(summary.driver)) return "provider";
  if (summary.cwd === null) return "no-folder";
  return null;
}

export class ExternalSessionNotFoundError extends Schema.TaggedError<ExternalSessionNotFoundError>()(
  "ExternalSessionNotFoundError",
  { key: Schema.String },
) {
  override get message(): string {
    return "This session is no longer listed.";
  }
}

export class ExternalSessionBusyError extends Schema.TaggedError<ExternalSessionBusyError>()(
  "ExternalSessionBusyError",
  { key: Schema.String },
) {
  override get message(): string {
    return "This session is still running. Stop it in the other app, then continue here.";
  }
}

export class ExternalSessionUnsupportedError extends Schema.TaggedError<ExternalSessionUnsupportedError>()(
  "ExternalSessionUnsupportedError",
  { key: Schema.String, reason: ExternalSessionUnsupportedReason },
) {
  override get message(): string {
    return EXTERNAL_SESSION_UNSUPPORTED_MESSAGES[this.reason];
  }
}

const ExternalSessionContinueRpcError = Schema.Union([
  ExternalSessionNotFoundError,
  ExternalSessionBusyError,
  ExternalSessionUnsupportedError,
  ExternalSessionError,
  EnvironmentAuthorizationError,
]);

export const ExternalSessionsSubscribeListRpc = Rpc.make(
  EXTERNAL_SESSIONS_WS_METHODS.subscribeList,
  {
    payload: ExternalSessionListInput,
    success: ExternalSessionListResult,
    error: ExternalSessionRpcError,
    stream: true,
  },
);

export const ExternalSessionsSubscribeSessionRpc = Rpc.make(
  EXTERNAL_SESSIONS_WS_METHODS.subscribeSession,
  {
    payload: ExternalSessionSubscribeInput,
    success: ExternalSessionEvent,
    error: ExternalSessionRpcError,
    stream: true,
  },
);

export const ExternalSessionsContinueRpc = Rpc.make(EXTERNAL_SESSIONS_WS_METHODS.continue, {
  payload: ExternalSessionContinueInput,
  success: ExternalSessionContinueResult,
  error: ExternalSessionContinueRpcError,
});

/** Continued T3 threads whose session is running in its own agent right now. */
export const ExternalSessionRunningElsewhereInput = Schema.Struct({});
export type ExternalSessionRunningElsewhereInput = typeof ExternalSessionRunningElsewhereInput.Type;

/** The whole set, sent on subscribe and whenever it changes. */
export const ExternalSessionRunningElsewhereResult = Schema.Struct({
  threadIds: Schema.Array(ThreadId),
});
export type ExternalSessionRunningElsewhereResult =
  typeof ExternalSessionRunningElsewhereResult.Type;

export const ExternalSessionsSubscribeRunningElsewhereRpc = Rpc.make(
  EXTERNAL_SESSIONS_WS_METHODS.subscribeRunningElsewhere,
  {
    payload: ExternalSessionRunningElsewhereInput,
    success: ExternalSessionRunningElsewhereResult,
    error: ExternalSessionRpcError,
    stream: true,
  },
);

/** Every external-session RPC, spread into the WebSocket RPC group. */
export const ExternalSessionsRpcs = [
  ExternalSessionsSubscribeListRpc,
  ExternalSessionsSubscribeSessionRpc,
  ExternalSessionsContinueRpc,
  ExternalSessionsSubscribeRunningElsewhereRpc,
] as const;

/** The scope each RPC needs, spread into the server's `RPC_REQUIRED_SCOPES`. */
export const EXTERNAL_SESSIONS_RPC_SCOPES = {
  [EXTERNAL_SESSIONS_WS_METHODS.subscribeList]: AuthOrchestrationReadScope,
  [EXTERNAL_SESSIONS_WS_METHODS.subscribeSession]: AuthOrchestrationReadScope,
  [EXTERNAL_SESSIONS_WS_METHODS.continue]: AuthOrchestrationOperateScope,
  [EXTERNAL_SESSIONS_WS_METHODS.subscribeRunningElsewhere]: AuthOrchestrationReadScope,
} as const;
