/**
 * External sessions: live views of agent sessions that run outside T3
 * (Claude Code, Codex, Grok, Pi, Antigravity CLIs and desktop apps), found in
 * each provider's own on-disk session store, and continuing an idle one as a
 * T3 thread. Fork add-on; see docs/internals/external-sessions.md.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

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
  archive: "externalSessions.archive",
  unarchive: "externalSessions.unarchive",
  subscribeArchived: "externalSessions.subscribeArchived",
  handBack: "externalSessions.handBack",
  release: "externalSessions.release",
  openInOrigin: "externalSessions.openInOrigin",
} as const;

/** The streaming methods, for the client's subscription tag union. */
export type ExternalSessionsSubscriptionMethod =
  | typeof EXTERNAL_SESSIONS_WS_METHODS.subscribeList
  | typeof EXTERNAL_SESSIONS_WS_METHODS.subscribeSession
  | typeof EXTERNAL_SESSIONS_WS_METHODS.subscribeRunningElsewhere
  | typeof EXTERNAL_SESSIONS_WS_METHODS.subscribeArchived;

/**
 * The local source updater's merge agent starts its prompt with this, so its
 * Claude sessions can be listed as upstream sync runs ("t3 mmddyy hhmmss").
 */
export const UPSTREAM_SYNC_PROMPT_PREFIX =
  "You are finishing a merge of the upstream T3 Code nightly";

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
});
export type ExternalSessionContinueInput = typeof ExternalSessionContinueInput.Type;

/** The T3 thread that owns the session, the same one each time. */
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

/**
 * A session archived in T3, or in Claude desktop (see `archivedIn`). Archive
 * is T3's own state, so every client of the environment agrees, and the
 * session stays where it is in the agent's own app. An archived session leaves
 * the list until unarchived, or until it runs again. The title and folder are
 * kept from archive time, since older Codex archives also archived in Codex,
 * which moves the session out of the store the list reads.
 */
export const ExternalSessionArchivedSession = Schema.Struct({
  key: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  title: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  archivedAt: Schema.String,
  /**
   * Archived in the agent's own store too (Codex archives made before T3's
   * archive became T3-only), so unarchive restores it there.
   */
  nativeArchived: Schema.Boolean,
  /**
   * Set when the agent's own app archived the session and T3 only mirrors
   * that: "claudeDesktop" is the Claude app. T3 cannot unarchive these; they
   * come back when unarchived there. Absent for T3's own archive.
   */
  archivedIn: Schema.optional(Schema.Literals(["claudeDesktop"])),
});
export type ExternalSessionArchivedSession = typeof ExternalSessionArchivedSession.Type;

export const ExternalSessionArchiveInput = Schema.Struct({
  key: TrimmedNonEmptyString,
});
export type ExternalSessionArchiveInput = typeof ExternalSessionArchiveInput.Type;

export const ExternalSessionUnarchiveInput = Schema.Struct({
  key: TrimmedNonEmptyString,
});
export type ExternalSessionUnarchiveInput = typeof ExternalSessionUnarchiveInput.Type;

/**
 * `warning` says why the agent could not unarchive the session in its own
 * store (an older Codex archive); archive never sets it. The change in T3
 * happened regardless.
 */
export const ExternalSessionArchiveResult = Schema.Struct({
  warning: Schema.NullOr(Schema.String),
});
export type ExternalSessionArchiveResult = typeof ExternalSessionArchiveResult.Type;

export const ExternalSessionArchivedInput = Schema.Struct({});
export type ExternalSessionArchivedInput = typeof ExternalSessionArchivedInput.Type;

/** Newest first; the whole set on subscribe and after every change. */
export const ExternalSessionArchivedResult = Schema.Struct({
  sessions: Schema.Array(ExternalSessionArchivedSession),
});
export type ExternalSessionArchivedResult = typeof ExternalSessionArchivedResult.Type;

export const ExternalSessionsArchiveRpc = Rpc.make(EXTERNAL_SESSIONS_WS_METHODS.archive, {
  payload: ExternalSessionArchiveInput,
  success: ExternalSessionArchiveResult,
  error: Schema.Union([
    ExternalSessionNotFoundError,
    ExternalSessionError,
    EnvironmentAuthorizationError,
  ]),
});

export const ExternalSessionsUnarchiveRpc = Rpc.make(EXTERNAL_SESSIONS_WS_METHODS.unarchive, {
  payload: ExternalSessionUnarchiveInput,
  success: ExternalSessionArchiveResult,
  error: ExternalSessionRpcError,
});

/**
 * The provider instance a thread was continued from, read from its id
 * (`import:<instance>:<session id>`, as continue and the onboarding importer
 * make it), or null for any other thread.
 */
export const continuedThreadOriginInstanceId = (threadId: string): ProviderInstanceId | null => {
  if (!threadId.startsWith("import:")) return null;
  const end = threadId.indexOf(":", "import:".length);
  return end === -1 ? null : ProviderInstanceId.make(threadId.slice("import:".length, end));
};

/** Hand a continued thread back to the agent it came from (see `handBack`). */
export const ExternalSessionHandBackInput = Schema.Struct({
  threadId: ThreadId,
});
export type ExternalSessionHandBackInput = typeof ExternalSessionHandBackInput.Type;

export const ExternalSessionHandBackResult = Schema.Struct({});
export type ExternalSessionHandBackResult = typeof ExternalSessionHandBackResult.Type;

export const ExternalSessionsHandBackRpc = Rpc.make(EXTERNAL_SESSIONS_WS_METHODS.handBack, {
  payload: ExternalSessionHandBackInput,
  success: ExternalSessionHandBackResult,
  error: ExternalSessionRpcError,
});

/**
 * Give a continued thread's session back to Other Agents: the thread is
 * archived, and continuing the session again unarchives it.
 */
export const ExternalSessionReleaseInput = Schema.Struct({
  threadId: ThreadId,
});
export type ExternalSessionReleaseInput = typeof ExternalSessionReleaseInput.Type;

export const ExternalSessionReleaseResult = Schema.Struct({});
export type ExternalSessionReleaseResult = typeof ExternalSessionReleaseResult.Type;

export const ExternalSessionsReleaseRpc = Rpc.make(EXTERNAL_SESSIONS_WS_METHODS.release, {
  payload: ExternalSessionReleaseInput,
  success: ExternalSessionReleaseResult,
  error: ExternalSessionRpcError,
});

/**
 * Whether the app a session runs in can be opened on it: Claude desktop and
 * the Codex app take a link to one session. Fork add-on.
 */
export const externalSessionOpensInOrigin = (session: {
  readonly driver: string;
  readonly origin: string | null;
}): boolean =>
  session.origin === "Desktop" && (session.driver === "claudeAgent" || session.driver === "codex");

/** Opens a session in the app it runs in, on the server's machine. */
export const ExternalSessionOpenInOriginInput = Schema.Struct({
  key: TrimmedNonEmptyString,
});
export type ExternalSessionOpenInOriginInput = typeof ExternalSessionOpenInOriginInput.Type;

export const ExternalSessionOpenInOriginResult = Schema.Struct({});
export type ExternalSessionOpenInOriginResult = typeof ExternalSessionOpenInOriginResult.Type;

export const ExternalSessionsOpenInOriginRpc = Rpc.make(EXTERNAL_SESSIONS_WS_METHODS.openInOrigin, {
  payload: ExternalSessionOpenInOriginInput,
  success: ExternalSessionOpenInOriginResult,
  error: ExternalSessionRpcError,
});

export const ExternalSessionsSubscribeArchivedRpc = Rpc.make(
  EXTERNAL_SESSIONS_WS_METHODS.subscribeArchived,
  {
    payload: ExternalSessionArchivedInput,
    success: ExternalSessionArchivedResult,
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
  ExternalSessionsArchiveRpc,
  ExternalSessionsUnarchiveRpc,
  ExternalSessionsSubscribeArchivedRpc,
  ExternalSessionsHandBackRpc,
  ExternalSessionsReleaseRpc,
  ExternalSessionsOpenInOriginRpc,
] as const;

/** The scope each RPC needs, spread into the server's `RPC_REQUIRED_SCOPES`. */
export const EXTERNAL_SESSIONS_RPC_SCOPES = {
  [EXTERNAL_SESSIONS_WS_METHODS.subscribeList]: AuthOrchestrationReadScope,
  [EXTERNAL_SESSIONS_WS_METHODS.subscribeSession]: AuthOrchestrationReadScope,
  [EXTERNAL_SESSIONS_WS_METHODS.continue]: AuthOrchestrationOperateScope,
  [EXTERNAL_SESSIONS_WS_METHODS.subscribeRunningElsewhere]: AuthOrchestrationReadScope,
  [EXTERNAL_SESSIONS_WS_METHODS.archive]: AuthOrchestrationOperateScope,
  [EXTERNAL_SESSIONS_WS_METHODS.unarchive]: AuthOrchestrationOperateScope,
  [EXTERNAL_SESSIONS_WS_METHODS.subscribeArchived]: AuthOrchestrationReadScope,
  [EXTERNAL_SESSIONS_WS_METHODS.handBack]: AuthOrchestrationOperateScope,
  [EXTERNAL_SESSIONS_WS_METHODS.release]: AuthOrchestrationOperateScope,
  [EXTERNAL_SESSIONS_WS_METHODS.openInOrigin]: AuthOrchestrationOperateScope,
} as const;
