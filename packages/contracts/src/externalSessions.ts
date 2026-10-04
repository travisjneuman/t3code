/**
 * External sessions: read-only views of agent sessions that run outside T3
 * (Claude Code, Codex, Grok, Pi, Antigravity CLIs and desktop apps), found in
 * each provider's own on-disk session store. Fork add-on; see
 * docs/internals/external-sessions.md.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const EXTERNAL_SESSIONS_WS_METHODS = {
  subscribeList: "externalSessions.subscribeList",
  subscribeSession: "externalSessions.subscribeSession",
} as const;

/**
 * running: written to in the last minute (or the provider reports it busy).
 * idle: touched within the last hour. recent: anything older still listed.
 */
export const ExternalSessionLiveness = Schema.Literals(["running", "idle", "recent"]);
export type ExternalSessionLiveness = typeof ExternalSessionLiveness.Type;

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
