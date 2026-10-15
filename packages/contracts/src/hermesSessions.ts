/**
 * Hermes Agent sessions: the sidebar's Hermes Agent section lists the
 * sessions a Hermes server holds (Discord, cron, the CLI and T3's own),
 * continues one in T3 as a thread in the Scratch project, and pins,
 * archives or deletes them in Hermes itself. `dashboard` reaches the
 * Hermes dashboard's config, key and custom-endpoint routes for
 * Settings › Providers; it never reveals a key's value. `t3Tools` gives
 * Hermes's API server T3's thread tools, or takes them away. Fork add-on;
 * see docs/user/hermes.md.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const HERMES_SESSIONS_WS_METHODS = {
  list: "hermesSessions.list",
  providers: "hermesSessions.providers",
  continue: "hermesSessions.continue",
  update: "hermesSessions.update",
  delete: "hermesSessions.delete",
  listArchived: "hermesSessions.listArchived",
  unarchive: "hermesSessions.unarchive",
  dashboard: "hermesSessions.dashboard",
  t3Tools: "hermesSessions.t3Tools",
} as const;

/** How far back the section lists sessions before "Load more"; pinned ones always show. */
export const HERMES_SESSIONS_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** How many older sessions each "Load more" adds. */
export const HERMES_SESSIONS_PAGE = 50;

export const HermesSessionSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  /** Where the session started: `discord`, `cron`, `cli`, `api_server`, … */
  source: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  /** Epoch milliseconds. */
  lastActiveAt: Schema.Number,
  messageCount: Schema.Number,
  pinned: Schema.Boolean,
  /** The T3 thread already bound to this session, if any. */
  threadId: Schema.NullOr(ThreadId),
});
export type HermesSessionSummary = typeof HermesSessionSummary.Type;

export const HermesSessionsListInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** Sessions older than the window to include, in multiples of `HERMES_SESSIONS_PAGE`. */
  extra: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type HermesSessionsListInput = typeof HermesSessionsListInput.Type;

export const HermesSessionsListResult = Schema.Struct({
  /** Pinned first, then newest first. */
  sessions: Schema.Array(HermesSessionSummary),
  hasMore: Schema.Boolean,
});
export type HermesSessionsListResult = typeof HermesSessionsListResult.Type;

export const HermesSessionsInstanceInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type HermesSessionsInstanceInput = typeof HermesSessionsInstanceInput.Type;

/** One provider Hermes knows, for the Settings checklist. */
export const HermesProviderSummary = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  authenticated: Schema.Boolean,
  /** False for providers T3 never offers through Hermes (Anthropic, Google sign-ins). */
  offerable: Schema.Boolean,
  modelCount: Schema.Number,
});
export type HermesProviderSummary = typeof HermesProviderSummary.Type;

export const HermesSessionsProvidersResult = Schema.Struct({
  providers: Schema.Array(HermesProviderSummary),
});
export type HermesSessionsProvidersResult = typeof HermesSessionsProvidersResult.Type;

export const HermesSessionsContinueInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  sessionId: TrimmedNonEmptyString,
});
export type HermesSessionsContinueInput = typeof HermesSessionsContinueInput.Type;

export const HermesSessionsContinueResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
});
export type HermesSessionsContinueResult = typeof HermesSessionsContinueResult.Type;

export const HermesSessionRef = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
});
export type HermesSessionRef = typeof HermesSessionRef.Type;

/** Pins, unpins or archives several sessions at once. */
export const HermesSessionsUpdateInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  sessions: Schema.Array(HermesSessionRef).check(Schema.isMinLength(1)),
  pinned: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Literal(true)),
});
export type HermesSessionsUpdateInput = typeof HermesSessionsUpdateInput.Type;

export const HermesSessionsDeleteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  sessionIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
});
export type HermesSessionsDeleteInput = typeof HermesSessionsDeleteInput.Type;

/** Each session either went or was refused (mid-turn, or Hermes said no) with a reason. */
export const HermesSessionsBatchResult = Schema.Struct({
  done: Schema.Array(Schema.String),
  refused: Schema.Array(Schema.Struct({ id: Schema.String, message: Schema.String })),
});
export type HermesSessionsBatchResult = typeof HermesSessionsBatchResult.Type;

export const HermesArchivedSession = Schema.Struct({
  instanceId: ProviderInstanceId,
  id: TrimmedNonEmptyString,
  title: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  /** ISO time. */
  archivedAt: Schema.String,
});
export type HermesArchivedSession = typeof HermesArchivedSession.Type;

export const HermesSessionsListArchivedResult = Schema.Struct({
  sessions: Schema.Array(HermesArchivedSession),
});
export type HermesSessionsListArchivedResult = typeof HermesSessionsListArchivedResult.Type;

export const HermesSessionsUnarchiveInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  sessionId: TrimmedNonEmptyString,
});
export type HermesSessionsUnarchiveInput = typeof HermesSessionsUnarchiveInput.Type;

/**
 * The dashboard routes Settings may call. `/api/env/reveal` is not one:
 * keys are write-only from T3.
 */
export const HERMES_DASHBOARD_PATH_PATTERN =
  /^\/api\/(?:config|config\/schema|config\/defaults|env|providers\/validate|providers\/custom-endpoints(?:\/validate|\/[A-Za-z0-9_.:-]+(?:\/activate)?)?)$/;

export const HermesDashboardInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  method: Schema.Literals(["GET", "PUT", "POST", "DELETE"]),
  path: Schema.String.check(Schema.isPattern(HERMES_DASHBOARD_PATH_PATTERN)),
  body: Schema.optional(Schema.Unknown),
});
export type HermesDashboardInput = typeof HermesDashboardInput.Type;

export const HermesDashboardResult = Schema.Struct({
  body: Schema.Unknown,
});
export type HermesDashboardResult = typeof HermesDashboardResult.Type;

/** Turns the instance's T3 tools on, at the T3 `/mcp` URL Hermes can reach, or off. */
export const HermesT3ToolsInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  enabled: Schema.Boolean,
  url: Schema.optional(TrimmedNonEmptyString),
});
export type HermesT3ToolsInput = typeof HermesT3ToolsInput.Type;

export const HermesSessionsEmptyResult = Schema.Struct({});
export type HermesSessionsEmptyResult = typeof HermesSessionsEmptyResult.Type;

export class HermesSessionsError extends Schema.TaggedError<HermesSessionsError>()(
  "HermesSessionsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const HermesSessionsRpcError = Schema.Union([HermesSessionsError, EnvironmentAuthorizationError]);

export const HermesSessionsListRpc = Rpc.make(HERMES_SESSIONS_WS_METHODS.list, {
  payload: HermesSessionsListInput,
  success: HermesSessionsListResult,
  error: HermesSessionsRpcError,
});

export const HermesSessionsProvidersRpc = Rpc.make(HERMES_SESSIONS_WS_METHODS.providers, {
  payload: HermesSessionsInstanceInput,
  success: HermesSessionsProvidersResult,
  error: HermesSessionsRpcError,
});

export const HermesSessionsContinueRpc = Rpc.make(HERMES_SESSIONS_WS_METHODS.continue, {
  payload: HermesSessionsContinueInput,
  success: HermesSessionsContinueResult,
  error: HermesSessionsRpcError,
});

export const HermesSessionsUpdateRpc = Rpc.make(HERMES_SESSIONS_WS_METHODS.update, {
  payload: HermesSessionsUpdateInput,
  success: HermesSessionsBatchResult,
  error: HermesSessionsRpcError,
});

export const HermesSessionsDeleteRpc = Rpc.make(HERMES_SESSIONS_WS_METHODS.delete, {
  payload: HermesSessionsDeleteInput,
  success: HermesSessionsBatchResult,
  error: HermesSessionsRpcError,
});

export const HermesSessionsListArchivedRpc = Rpc.make(HERMES_SESSIONS_WS_METHODS.listArchived, {
  payload: Schema.Struct({}),
  success: HermesSessionsListArchivedResult,
  error: HermesSessionsRpcError,
});

export const HermesSessionsUnarchiveRpc = Rpc.make(HERMES_SESSIONS_WS_METHODS.unarchive, {
  payload: HermesSessionsUnarchiveInput,
  success: HermesSessionsEmptyResult,
  error: HermesSessionsRpcError,
});

export const HermesSessionsDashboardRpc = Rpc.make(HERMES_SESSIONS_WS_METHODS.dashboard, {
  payload: HermesDashboardInput,
  success: HermesDashboardResult,
  error: HermesSessionsRpcError,
});

export const HermesSessionsT3ToolsRpc = Rpc.make(HERMES_SESSIONS_WS_METHODS.t3Tools, {
  payload: HermesT3ToolsInput,
  success: HermesSessionsEmptyResult,
  error: HermesSessionsRpcError,
});

export const HermesSessionsRpcs = [
  HermesSessionsListRpc,
  HermesSessionsProvidersRpc,
  HermesSessionsContinueRpc,
  HermesSessionsUpdateRpc,
  HermesSessionsDeleteRpc,
  HermesSessionsListArchivedRpc,
  HermesSessionsUnarchiveRpc,
  HermesSessionsDashboardRpc,
  HermesSessionsT3ToolsRpc,
] as const;

/** The scope each RPC needs, spread into the server's `RPC_REQUIRED_SCOPES`. */
export const HERMES_SESSIONS_RPC_SCOPES = {
  [HERMES_SESSIONS_WS_METHODS.list]: AuthOrchestrationReadScope,
  [HERMES_SESSIONS_WS_METHODS.providers]: AuthOrchestrationReadScope,
  [HERMES_SESSIONS_WS_METHODS.continue]: AuthOrchestrationOperateScope,
  [HERMES_SESSIONS_WS_METHODS.update]: AuthOrchestrationOperateScope,
  [HERMES_SESSIONS_WS_METHODS.delete]: AuthOrchestrationOperateScope,
  [HERMES_SESSIONS_WS_METHODS.listArchived]: AuthOrchestrationReadScope,
  [HERMES_SESSIONS_WS_METHODS.unarchive]: AuthOrchestrationOperateScope,
  [HERMES_SESSIONS_WS_METHODS.dashboard]: AuthProvidersManageScope,
  [HERMES_SESSIONS_WS_METHODS.t3Tools]: AuthProvidersManageScope,
} as const;
