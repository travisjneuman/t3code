/**
 * Hermes Agent over its HTTP API. Hermes runs on another machine, so there is
 * no host process: each T3 thread is one Hermes session, each turn one
 * `/v1/runs` run, and its SSE event stream becomes T3 turn items. Images go
 * inline in the run request because Hermes cannot read T3's attachment store.
 */
import {
  ProviderDriverKind,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2TurnItemStatus,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderInstanceId,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { isProviderNativeImageAttachment } from "@t3tools/provider-core/server/attachmentPrompt";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";

import type { HermesSettings } from "../settings.ts";
import * as HermesApi from "./api.ts";
import { hermesRunModel, isBlockedHermesModel } from "./models.ts";

const HERMES_PROVIDER = ProviderDriverKind.make("hermes");

/**
 * A turn T3 refused before anything reached Hermes, such as an unreadable image or an
 * oversized body. `makeProviderFailure` shows its message instead of the generic
 * start-failure advice, which would tell the user to retry a send that cannot succeed.
 */
class HermesTurnNotSentError extends Schema.TaggedError<HermesTurnNotSentError>()(
  "HermesTurnNotSentError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const TOOL_AS_COMMAND = /terminal|shell|bash|exec/i;
const FLUSH_DELAY_MS = 50;

const PLAN_MODE_INSTRUCTIONS = `<t3_code_interaction_mode>Plan mode. Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it.</t3_code_interaction_mode>`;

const HermesProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    // A turn is known by T3's attempt id; Hermes names the run only once it accepts it.
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    // Hermes works on its own machine; T3 has no files of its to checkpoint.
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "weak",
    nativeRequestIds: "weak",
  },
} satisfies OrchestrationV2ProviderCapabilities;

// Fork add-on: Hermes T3 tools. Added to each run while the T3 tools switch is on.
const T3_TOOLS_INSTRUCTIONS = `<t3_code_coworkers>You can start T3 Code coworker threads (Codex, Claude, Grok and other agents) through the t3-code MCP tools. Find the project with t3_project_list, pick a model with orchestrator_capabilities, start each coworker with t3_thread_launch giving projectId and a modelSelection for that agent, then follow it with t3_thread_wait and t3_thread_read, or steer it with t3_thread_send. Always pass modelSelection: without it the coworker is another Hermes thread, and Hermes threads always run in T3's Scratch project, whatever projectId you give. Each coworker is its own thread in its project, not nested under this one, so link it for the user as [title](t3-thread://v1/<threadId>).</t3_code_coworkers>`;

export interface HermesAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: HermesSettings;
}

type HermesChoice = "once" | "session" | "always" | "deny";
const CHOICE_BY_DECISION: Partial<Record<ProviderApprovalDecision, HermesChoice>> = {
  accept: "once",
  acceptForSession: "session",
  acceptAlways: "always",
  decline: "deny",
  cancel: "deny",
};
const APPROVAL_OPTIONS: Record<HermesChoice, ProviderApprovalOption> = {
  once: { decision: "accept", label: "Allow once" },
  session: { decision: "acceptForSession", label: "Allow for this session" },
  always: { decision: "acceptAlways", label: "Always allow" },
  deny: { decision: "decline", label: "Deny" },
};

interface ToolItem {
  readonly nativeId: string;
  readonly name: string;
  readonly input: string;
}

interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly nativeId: string;
  /** Hermes's run id, once it accepted the run. */
  runId?: string;
  readonly ordinals: Map<string, number>;
  readonly started: Map<string, DateTime.Utc>;
  readonly done: Deferred.Deferred<void>;
  readonly abort: AbortController;
  /** Open tool rows by tool name, oldest first: Hermes settles them in that order. */
  readonly openTools: Map<string, Array<ToolItem>>;
  readonly subagents: Map<string, { readonly nativeId: string; readonly prompt: string }>;
  /** The assistant text segment still receiving deltas. */
  segment?: { readonly nativeId: string; text: string; dirty: boolean };
  /** Whether any assistant text arrived since the last tool started. */
  textSinceTool: boolean;
  counter: number;
  nextOrdinal: number;
  flushScheduled: boolean;
}

interface PendingRequest {
  readonly turn: ActiveTurn;
  readonly nativeRequestId: string | undefined;
  request: OrchestrationV2RuntimeRequest;
  node: OrchestrationV2ExecutionNode;
  item: OrchestrationV2TurnItem;
  response?: Pick<OrchestrationV2RuntimeRequest, "decision">;
}

const nativeRef = (nativeId: string, strength: "strong" | "weak" = "weak") => ({
  driver: HERMES_PROVIDER,
  nativeId,
  strength,
});
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const errorText = (value: unknown, fallback: string) => {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "object" && value !== null && "message" in value)
    return str((value as { message?: unknown }).message) ?? fallback;
  return fallback;
};
const previewText = (value: unknown) =>
  typeof value === "string"
    ? value
    : value === undefined || value === null
      ? ""
      : JSON.stringify(value);

/** One Hermes session per T3 thread; the orchestrator owns runs and queuing. */
export const makeHermesAdapterV2 = Effect.fn("makeHermesAdapterV2")(function* (
  options: HermesAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const providerHost = yield* ProviderHost.ProviderHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const connection = HermesApi.connectionOf(options.settings);
  // Fork add-on: Hermes T3 tools.
  const capabilities: OrchestrationV2ProviderCapabilities = options.settings.t3Tools
    ? {
        ...HermesProviderCapabilitiesV2,
        tools: { ...HermesProviderCapabilitiesV2.tools, supportsMcpTools: true },
      }
    : HermesProviderCapabilitiesV2;

  const protocolError = (detail: string, payload?: unknown, cause?: HermesTurnNotSentError) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: HERMES_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
      ...(cause === undefined ? {} : { cause }),
    });
  const notSentError = (detail: string, payload?: unknown) =>
    protocolError(detail, payload, new HermesTurnNotSentError({ detail }));
  const api = <A>(effect: Effect.Effect<A, HermesApi.HermesApiError>) =>
    effect.pipe(
      Effect.mapError((error) =>
        error.code === "body_too_large"
          ? notSentError(error.detail, error)
          : protocolError(error.detail, error),
      ),
    );

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: HERMES_PROVIDER,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("HermesAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      if (!options.settings.enabled) return yield* protocolError("Hermes Agent is disabled");
      if (!connection.apiUrl)
        return yield* protocolError(
          "Set the Hermes API URL in Settings › Providers › Hermes Agent",
        );
      const scope = yield* Effect.scope;
      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: HERMES_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd: input.runtimePolicy.cwd ?? providerHost.paths.cwd,
        model: input.modelSelection.model,
        capabilities,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const commands = yield* Semaphore.make(1);
      const eventPermit = yield* Semaphore.make(1);
      let closed = false;
      let nativeSessionId: string | undefined;
      let thread: OrchestrationV2ProviderThread | undefined;
      let active: ActiveTurn | undefined;
      const pending = new Map<RuntimeRequestId, PendingRequest>();

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) {
        session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_session.updated",
          driver: HERMES_PROVIDER,
          providerSession: session,
        });
      });
      const updateThread = Effect.fnUntraced(function* (
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        if (!thread) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_thread.updated",
          driver: HERMES_PROVIDER,
          providerThread: thread,
        });
      });

      const itemIdentity = (turn: ActiveTurn, nativeId: string) =>
        `${options.instanceId}:${turn.input.providerThread.id}:${turn.nativeId}:${nativeId}`;
      const baseItem = (turn: ActiveTurn, nativeId: string, time: DateTime.Utc) => {
        if (!turn.ordinals.has(nativeId)) turn.ordinals.set(nativeId, turn.nextOrdinal++);
        if (!turn.started.has(nativeId)) turn.started.set(nativeId, time);
        const identity = itemIdentity(turn, nativeId);
        return {
          id: idAllocator.derive.turnItemFromProviderItem({
            driver: HERMES_PROVIDER,
            nativeItemId: identity,
          }),
          nodeId: idAllocator.derive.nodeFromProviderItem({
            driver: HERMES_PROVIDER,
            nativeItemId: identity,
          }),
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: nativeRef(nativeId),
          parentItemId: null,
          ordinal: turn.ordinals.get(nativeId)!,
          startedAt: turn.started.get(nativeId)!,
          updatedAt: time,
        };
      };
      const nextId = (turn: ActiveTurn, kind: string) => `${kind}-${++turn.counter}`;

      /** Publishes one row: its execution node and its turn item. */
      const publishRow = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        base: ReturnType<typeof baseItem>,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2TurnItemStatus,
        turnItem: OrchestrationV2TurnItem,
        nativeItemRef = base.nativeItemRef,
      ) {
        const completedAt = status === "running" || status === "pending" ? null : base.updatedAt;
        yield* emit({
          type: "node.updated",
          driver: HERMES_PROVIDER,
          node: {
            id: base.nodeId,
            threadId: base.threadId,
            runId: base.runId,
            parentNodeId: turn.input.rootNodeId,
            rootNodeId: turn.input.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: base.providerThreadId,
            providerTurnId: base.providerTurnId,
            nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: base.startedAt,
            completedAt,
          },
        });
        yield* emit({ type: "turn_item.updated", driver: HERMES_PROVIDER, turnItem });
      });

      const publishMessage = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        nativeId: string,
        text: string,
        streaming: boolean,
      ) {
        const time = yield* DateTime.now;
        const base = baseItem(turn, nativeId, time);
        const status = streaming ? "running" : "completed";
        const messageId = idAllocator.derive.messageFromProviderItem({
          driver: HERMES_PROVIDER,
          nativeItemId: itemIdentity(turn, nativeId),
        });
        const message: OrchestrationV2ConversationMessage = {
          id: messageId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          nodeId: base.nodeId,
          role: "assistant",
          text,
          attachments: [],
          streaming,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: base.startedAt,
          updatedAt: time,
        };
        yield* emit({ type: "message.updated", driver: HERMES_PROVIDER, message });
        yield* publishRow(turn, base, "assistant_message", status, {
          ...base,
          type: "assistant_message",
          status,
          title: null,
          completedAt: streaming ? null : time,
          messageId,
          text,
          streaming,
        });
      });

      /** Sends the open segment's text if it changed since the last send. */
      const flushSegment = Effect.fnUntraced(function* (turn: ActiveTurn) {
        turn.flushScheduled = false;
        const segment = turn.segment;
        if (!segment?.dirty || active !== turn) return;
        segment.dirty = false;
        yield* publishMessage(turn, segment.nativeId, segment.text, true);
      });
      const closeSegment = Effect.fnUntraced(function* (turn: ActiveTurn, text?: string) {
        const segment = turn.segment;
        if (!segment) return;
        turn.segment = undefined;
        yield* publishMessage(turn, segment.nativeId, text ?? segment.text, false);
      });

      const publishTool = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        tool: ToolItem,
        status: OrchestrationV2TurnItemStatus,
        output?: string,
      ) {
        const time = yield* DateTime.now;
        const base = baseItem(turn, tool.nativeId, time);
        const common = {
          ...base,
          status,
          title: tool.name,
          completedAt: status === "running" ? null : time,
        };
        const turnItem: OrchestrationV2TurnItem = TOOL_AS_COMMAND.test(tool.name)
          ? {
              ...common,
              type: "command_execution",
              input: tool.input,
              ...(output === undefined ? {} : { output }),
              ...(status === "failed" ? { outputIndicatesFailure: true } : {}),
            }
          : {
              ...common,
              type: "dynamic_tool",
              toolName: tool.name.trim() || null,
              input: tool.input,
              ...(output === undefined ? {} : { output }),
            };
        yield* publishRow(turn, base, "tool_call", status, turnItem);
      });

      const publishReasoning = Effect.fnUntraced(function* (turn: ActiveTurn, text: string) {
        const time = yield* DateTime.now;
        const base = baseItem(turn, nextId(turn, "reasoning"), time);
        yield* publishRow(turn, base, "reasoning", "completed", {
          ...base,
          type: "reasoning",
          status: "completed",
          title: null,
          completedAt: time,
          text,
          streaming: false,
        });
      });

      const publishSubagent = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        event: HermesApi.HermesRunEvent,
        settled: boolean,
      ) {
        const key =
          str(event.subagent_id) ?? str(event.delegation_id) ?? str(event.child_session_id);
        const known = key ? turn.subagents.get(key) : undefined;
        const nativeId = known?.nativeId ?? nextId(turn, "subagent");
        const prompt = known?.prompt ?? str(event.goal) ?? str(event.preview) ?? "";
        if (key && !known) turn.subagents.set(key, { nativeId, prompt });
        const time = yield* DateTime.now;
        const base = baseItem(turn, nativeId, time);
        const failed = /fail|error/i.test(str(event.status) ?? "");
        const status: OrchestrationV2TurnItemStatus = !settled
          ? "running"
          : failed
            ? "failed"
            : "completed";
        const result = settled ? (str(event.summary) ?? str(event.output_tail) ?? null) : null;
        const title = prompt.split("\n")[0]?.slice(0, 80) || "Subagent";
        const nativeTaskRef = nativeRef(key ?? nativeId);
        const subagent: OrchestrationV2Subagent = {
          id: base.nodeId,
          threadId: base.threadId,
          runId: base.runId,
          parentNodeId: turn.input.rootNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver: HERMES_PROVIDER,
          providerInstanceId: options.instanceId,
          providerThreadId: base.providerThreadId,
          childThreadId: null,
          nativeTaskRef,
          prompt,
          title,
          model: str(event.model) ?? null,
          status,
          result,
          startedAt: base.startedAt,
          completedAt: settled ? time : null,
          updatedAt: time,
        };
        yield* emit({ type: "subagent.updated", driver: HERMES_PROVIDER, subagent });
        yield* publishRow(
          turn,
          base,
          "subagent",
          status,
          {
            ...base,
            nativeItemRef: nativeTaskRef,
            type: "subagent",
            status,
            title,
            completedAt: subagent.completedAt,
            subagentId: subagent.id,
            origin: "provider_native",
            driver: HERMES_PROVIDER,
            providerInstanceId: options.instanceId,
            childThreadId: null,
            prompt,
            result,
          },
          nativeTaskRef,
        );
      });

      const resolvePending = Effect.fnUntraced(function* (
        entry: PendingRequest,
        status: "resolved" | "cancelled",
      ) {
        if (!pending.has(entry.request.id)) return;
        pending.delete(entry.request.id);
        const time = yield* DateTime.now;
        entry.request = {
          ...entry.request,
          ...(status === "resolved" ? entry.response : undefined),
          status,
          resolvedAt: time,
          responseCapability: { type: "not_resumable", reason: "This Hermes request has ended." },
        };
        entry.node = {
          ...entry.node,
          status: status === "resolved" ? "completed" : "cancelled",
          completedAt: time,
        };
        entry.item = {
          ...entry.item,
          status: status === "resolved" ? "completed" : "cancelled",
          completedAt: time,
          updatedAt: time,
        };
        yield* emit({
          type: "runtime_request.updated",
          driver: HERMES_PROVIDER,
          threadId: entry.turn.input.threadId,
          runtimeRequest: entry.request,
        });
        yield* emit({ type: "node.updated", driver: HERMES_PROVIDER, node: entry.node });
        yield* emit({ type: "turn_item.updated", driver: HERMES_PROVIDER, turnItem: entry.item });
        if (pending.size === 0 && active === entry.turn) yield* updateSession("running");
      });

      /** Shows a Hermes approval (a flagged command) as a T3 request. */
      const publishRequest = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        event: HermesApi.HermesRunEvent,
      ) {
        if (!thread) return;
        const nativeRequestId = str(event.request_id);
        const nativeId = nativeRequestId ?? nextId(turn, "approval");
        const providerTurnId = turn.providerTurn.id;
        const requestId = yield* idAllocator.allocate
          .runtimeRequest({
            driver: HERMES_PROVIDER,
            providerTurnId,
            nativeRequestId: `${turn.nativeId}:${nativeId}`,
          })
          .pipe(Effect.mapError((cause) => protocolError("Cannot allocate Hermes request", cause)));
        const time = yield* DateTime.now;
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId,
          nativeRequestRef: nativeRef(nativeId),
          kind: "command",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt: time,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind: "approval_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: thread.id,
          providerTurnId,
          nativeItemRef: nativeRef(nativeId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: time,
          completedAt: null,
        };
        const choices = Array.isArray(event.choices)
          ? event.choices.filter((choice): choice is HermesChoice => choice in APPROVAL_OPTIONS)
          : (["once", "deny"] as const);
        const item: OrchestrationV2TurnItem = {
          ...baseItem(turn, `request:${nativeId}`, time),
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          nodeId,
          status: "waiting",
          title: null,
          completedAt: null,
          type: "approval_request",
          requestId,
          requestKind: "command",
          prompt:
            [str(event.description), str(event.command)].filter(Boolean).join("\n\n") ||
            "Hermes Agent asks to run a flagged command",
          options: choices.map((choice) => APPROVAL_OPTIONS[choice]),
        };
        pending.set(requestId, { turn, nativeRequestId, request: runtimeRequest, node, item });
        yield* emit({
          type: "runtime_request.updated",
          driver: HERMES_PROVIDER,
          threadId: turn.input.threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: HERMES_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: HERMES_PROVIDER, turnItem: item });
        yield* updateSession("waiting");
      });

      /** Marks a steering message with images as not delivered, inside the running turn. */
      const notDelivered = Effect.fnUntraced(function* (turn: ActiveTurn, messageId: string) {
        const time = yield* DateTime.now;
        const base = baseItem(turn, `not-delivered:${messageId}`, time);
        yield* publishRow(turn, base, "system", "failed", {
          ...base,
          type: "error",
          status: "failed",
          title: "Message not sent",
          completedAt: time,
          failure: makeProviderFailure({
            class: "provider_error",
            message:
              "Hermes cannot take images while a run is active, so this message was not sent. Send it again after the run finishes.",
            retryable: false,
          }),
        });
      });

      const finish = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        status: "completed" | "cancelled" | "interrupted" | "failed",
        detail?: string,
      ) {
        if (active !== turn) return;
        const completedAt = yield* DateTime.now;
        if (turn.segment) yield* closeSegment(turn);
        for (const tools of turn.openTools.values())
          for (const tool of tools)
            yield* publishTool(turn, tool, status === "completed" ? "completed" : "cancelled");
        turn.openTools.clear();
        for (const entry of pending.values())
          if (entry.turn === turn) yield* resolvePending(entry, "cancelled");
        turn.abort.abort();
        turn.providerTurn = { ...turn.providerTurn, status, completedAt };
        yield* emit({
          type: "provider_turn.updated",
          driver: HERMES_PROVIDER,
          threadId: turn.input.threadId,
          providerTurn: turn.providerTurn,
        });
        yield* updateThread({
          status: "idle",
          ...(status === "completed" && turn.runId
            ? { nativeConversationHeadRef: nativeRef(turn.runId) }
            : {}),
        });
        yield* updateSession("ready", detail ?? null);
        active = undefined;
        if (status === "failed") {
          const failure = makeProviderFailure({
            class: "provider_error",
            message: detail ?? "Hermes run failed.",
          });
          const base = baseItem(turn, `failure:${turn.nativeId}`, completedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: HERMES_PROVIDER,
            turnItem: {
              ...base,
              type: "error",
              status: "failed",
              title: null,
              completedAt,
              failure,
            },
          });
          yield* emit({
            type: "turn.terminal",
            driver: HERMES_PROVIDER,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure,
            failureItemOrdinal: base.ordinal,
            threadDisposition: "reusable",
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver: HERMES_PROVIDER,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure: null,
            threadDisposition: "reusable",
          });
        }
        yield* Deferred.succeed(turn.done, undefined);
      });

      /**
       * Hermes moves a session to a new id when it compresses the conversation.
       * The finished run names the session it ended in; T3 follows it there.
       */
      const followSessionRotation = Effect.fnUntraced(function* (turn: ActiveTurn) {
        if (!turn.runId) return;
        const record = yield* HermesApi.getRun(connection, turn.runId).pipe(
          Effect.timeout(5_000),
          Effect.orElseSucceed(() => ({}) as Record<string, unknown>),
        );
        const rotated = str(record.session_id);
        if (!rotated || rotated === nativeSessionId) return;
        nativeSessionId = rotated;
        yield* updateThread({ nativeThreadRef: nativeRef(rotated, "strong") });
      });

      const handleEvent = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        event: HermesApi.HermesRunEvent,
      ) {
        if (active !== turn) return;
        switch (event.event) {
          case "message.delta": {
            const delta = str(event.delta) ?? "";
            if (!delta) return;
            turn.segment ??= { nativeId: nextId(turn, "message"), text: "", dirty: false };
            turn.segment.text += delta;
            turn.segment.dirty = true;
            turn.textSinceTool = true;
            if (!turn.flushScheduled) {
              turn.flushScheduled = true;
              yield* Effect.sleep(FLUSH_DELAY_MS).pipe(
                Effect.andThen(eventPermit.withPermits(1)(flushSegment(turn))),
                Effect.forkIn(scope),
              );
            }
            return;
          }
          case "message.interim": {
            const text = str(event.text) ?? "";
            if (event.already_streamed === true) yield* closeSegment(turn, text || undefined);
            else if (text.trim()) {
              yield* closeSegment(turn);
              yield* publishMessage(turn, nextId(turn, "message"), text, false);
            }
            turn.textSinceTool = true;
            return;
          }
          case "reasoning.available": {
            const text = str(event.text) ?? "";
            if (text.trim()) yield* publishReasoning(turn, text);
            return;
          }
          case "tool.started": {
            yield* closeSegment(turn);
            turn.textSinceTool = false;
            const name = str(event.tool) ?? "tool";
            const tool: ToolItem = {
              nativeId: nextId(turn, "tool"),
              name,
              input: previewText(event.preview),
            };
            turn.openTools.set(name, [...(turn.openTools.get(name) ?? []), tool]);
            yield* publishTool(turn, tool, "running");
            return;
          }
          case "tool.completed": {
            const name = str(event.tool) ?? "tool";
            const queue = turn.openTools.get(name) ?? [];
            const tool = queue.shift() ?? { nativeId: nextId(turn, "tool"), name, input: "" };
            if (queue.length === 0) turn.openTools.delete(name);
            yield* publishTool(
              turn,
              tool,
              event.error === true ? "failed" : "completed",
              previewText(event.preview),
            );
            return;
          }
          case "subagent.start":
          case "subagent.complete":
            yield* publishSubagent(turn, event, event.event === "subagent.complete");
            return;
          case "approval.request":
            yield* publishRequest(turn, event);
            return;
          case "approval.responded": {
            const requestId = str(event.request_id);
            for (const entry of [...pending.values()])
              if (entry.turn === turn && (!requestId || entry.nativeRequestId === requestId))
                yield* resolvePending(entry, "resolved");
            return;
          }
          case "run.completed": {
            const output = str(event.output) ?? "";
            if (turn.segment) yield* closeSegment(turn, output || undefined);
            else if (!turn.textSinceTool && output.trim())
              yield* publishMessage(turn, nextId(turn, "message"), output, false);
            yield* followSessionRotation(turn);
            yield* finish(turn, "completed");
            return;
          }
          case "run.failed":
            yield* followSessionRotation(turn);
            yield* finish(turn, "failed", errorText(event.error, "Hermes run failed."));
            return;
          case "run.cancelled":
          case "run.interrupted":
            yield* followSessionRotation(turn);
            yield* finish(turn, "interrupted");
            return;
          default:
            return;
        }
      });

      /** Follows one run's events until it ends; a lost stream fails the turn, not the session. */
      const followRun = (turn: ActiveTurn, runId: string) =>
        Stream.fromAsyncIterable(
          HermesApi.runEvents(connection, runId, turn.abort.signal),
          (cause) => protocolError("Hermes run stream failed", cause),
        ).pipe(
          Stream.runForEach((event) => eventPermit.withPermits(1)(handleEvent(turn, event))),
          Effect.catchCause((cause) =>
            Effect.sync(() => Cause.squash(cause)).pipe(
              Effect.flatMap((error) =>
                eventPermit.withPermits(1)(
                  finish(
                    turn,
                    "failed",
                    error instanceof Error ? error.message : "Lost the Hermes run stream.",
                  ),
                ),
              ),
            ),
          ),
          Effect.andThen(
            eventPermit.withPermits(1)(
              finish(turn, "failed", "The Hermes run stream ended without a result."),
            ),
          ),
          Effect.forkIn(scope),
        );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          if (active) {
            const turn = active;
            if (turn.runId) yield* HermesApi.stopRun(connection, turn.runId).pipe(Effect.ignore);
            yield* finish(turn, "cancelled", "Hermes session closed");
          }
          yield* Queue.shutdown(events);
        }).pipe(eventPermit.withPermits(1)),
      );

      const register = Effect.fnUntraced(function* (
        args: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        if (closed) return yield* protocolError("Hermes session is closed; reopen it");
        if (active)
          return yield* protocolError("Cannot change Hermes sessions during an active turn");
        const existing = args.existingProviderThread;
        if (
          existing &&
          (existing.driver !== HERMES_PROVIDER ||
            existing.providerInstanceId !== options.instanceId)
        )
          return yield* protocolError("Hermes thread belongs to another provider instance");
        const requestedId = existing
          ? (existing.nativeThreadRef?.nativeId ?? undefined)
          : input.initialNativeThreadId;
        if (
          thread &&
          (!requestedId || requestedId === nativeSessionId) &&
          thread.appThreadId === args.threadId
        )
          return thread;
        if (thread)
          return yield* protocolError("Open a new session to attach another Hermes session");
        // Never pass a model here: a session created with one stays on it.
        nativeSessionId = requestedId ?? (yield* api(HermesApi.createSession(connection))).id;
        const createdAt = yield* DateTime.now;
        thread = existing
          ? {
              ...existing,
              providerSessionId: input.providerSessionId,
              nativeThreadRef: nativeRef(nativeSessionId, "strong"),
              status: "idle",
              updatedAt: createdAt,
            }
          : {
              id: idAllocator.derive.providerThread({
                driver: HERMES_PROVIDER,
                providerInstanceId: options.instanceId,
                nativeThreadId: nativeSessionId,
              }),
              driver: HERMES_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: args.threadId,
              ownerNodeId: null,
              nativeThreadRef: nativeRef(nativeSessionId, "strong"),
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            };
        yield* emit({
          type: "provider_thread.updated",
          driver: HERMES_PROVIDER,
          providerThread: thread,
        });
        return thread;
      });

      const validateThread = (candidate: OrchestrationV2ProviderThread) =>
        thread !== undefined &&
        candidate.driver === HERMES_PROVIDER &&
        candidate.providerInstanceId === options.instanceId &&
        candidate.appThreadId === thread.appThreadId;

      /** The message text; files other than images cannot reach Hermes, so they are named. */
      const promptText = (message: ProviderAdapter.ProviderAdapterV2TurnMessage) => {
        const names = message.attachments
          .filter((attachment) => attachment.type !== "image")
          .map((attachment) => attachment.name);
        const note = names.length
          ? `\n\n(T3 Code could not send ${names.length === 1 ? "this file" : "these files"} to Hermes: ${names.join(", ")})`
          : "";
        return `${message.text}${note}`.trim();
      };

      /**
       * Reads each image from T3's attachment store into a data URL part. Any image that
       * cannot go fails the whole turn, so text never reaches Hermes looking complete
       * without the image the user attached.
       */
      const imageParts = Effect.fnUntraced(function* (
        message: ProviderAdapter.ProviderAdapterV2TurnMessage,
        correlationId: string,
      ) {
        const parts: HermesApi.HermesContentPart[] = [];
        for (const attachment of message.attachments) {
          if (attachment.type !== "image") continue;
          const log = {
            correlationId,
            attachmentId: attachment.id,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          };
          const fail = (category: string, detail: string) =>
            Effect.logWarning("hermes.attachment.rejected", { ...log, category }).pipe(
              Effect.andThen(Effect.fail(notSentError(detail))),
            );
          if (!isProviderNativeImageAttachment(attachment))
            return yield* fail(
              "unsupported_type",
              `Hermes accepts PNG, JPEG, GIF, or WebP images; ${attachment.name} is ${attachment.mimeType}.`,
            );
          const path = providerHost.resolveAttachmentPath(attachment);
          if (path === null)
            return yield* fail(
              "unresolved",
              `T3 Code no longer has ${attachment.name}. Attach it again and resend.`,
            );
          const bytes = yield* fileSystem
            .readFile(path)
            .pipe(
              Effect.catch(() =>
                fail(
                  "unreadable",
                  `T3 Code could not read ${attachment.name}. Attach it again and resend.`,
                ),
              ),
            );
          parts.push({
            type: "image_url",
            image_url: {
              url: `data:${attachment.mimeType.toLowerCase()};base64,${Buffer.from(bytes).toString("base64")}`,
            },
          });
          yield* Effect.logInfo("hermes.attachment.inlined", { ...log, bytes: bytes.byteLength });
        }
        return parts;
      });

      const start = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        if (!validateThread(turnInput.providerThread) || closed || !nativeSessionId)
          return yield* protocolError("Hermes thread is not attached to this session");
        if (active)
          return yield* protocolError(
            "Hermes already has an active turn; queue through the orchestrator",
          );
        const selection = turnInput.modelSelection;
        if (selection.instanceId !== options.instanceId)
          return yield* protocolError("Model selection belongs to another Hermes instance");
        if (isBlockedHermesModel(selection.model))
          return yield* protocolError("This model is not offered through Hermes Agent");
        const text = promptText(turnInput.message);
        const hasImages = turnInput.message.attachments.some((a) => a.type === "image");
        if (!text && !hasImages) return yield* protocolError("Hermes Agent needs a text message");
        const { provider, model } = hermesRunModel(selection.model);
        const reasoningEffort = getModelSelectionStringOptionValue(selection, "reasoningEffort");
        const fast = getModelSelectionBooleanOptionValue(selection, "fastMode");
        const nativeId = String(turnInput.attemptId);
        const startedAt = yield* DateTime.now;
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: idAllocator.derive.providerTurn({
            driver: HERMES_PROVIDER,
            nativeTurnId: `${options.instanceId}:${turnInput.providerThread.id}:${nativeId}`,
          }),
          providerThreadId: turnInput.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          nativeTurnRef: nativeRef(nativeId),
          ordinal: turnInput.providerTurnOrdinal,
          status: "running",
          startedAt,
          completedAt: null,
        };
        const turn: ActiveTurn = {
          input: turnInput,
          providerTurn,
          nativeId,
          ordinals: new Map(),
          started: new Map(),
          done: yield* Deferred.make<void>(),
          abort: new AbortController(),
          openTools: new Map(),
          subagents: new Map(),
          textSinceTool: false,
          counter: 0,
          nextOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
          flushScheduled: false,
        };
        yield* Effect.gen(function* () {
          thread = turnInput.providerThread;
          active = turn;
          session = { ...session, model: selection.model };
          yield* emit({
            type: "provider_turn.updated",
            driver: HERMES_PROVIDER,
            threadId: turnInput.threadId,
            providerTurn,
          });
          yield* updateThread({
            status: "active",
            firstRunOrdinal: thread.firstRunOrdinal ?? turnInput.runOrdinal,
            lastRunOrdinal: turnInput.runOrdinal,
          });
          yield* updateSession("running");
        }).pipe(eventPermit.withPermits(1));
        const instructions = [
          buildRuntimeInstructions({
            harness: "Hermes Agent",
            model,
            reasoningEffort,
            agentScope: { thread: turnInput.appThread, provider: HERMES_PROVIDER }, // Fork add-on: agent instructions.
          }),
          ...(turnInput.runtimePolicy.interactionMode === "plan" ? [PLAN_MODE_INSTRUCTIONS] : []),
          ...(options.settings.t3Tools ? [T3_TOOLS_INSTRUCTIONS] : []), // Fork add-on: Hermes T3 tools.
        ].join("\n\n");
        yield* Effect.gen(function* () {
          const images = hasImages ? yield* imageParts(turnInput.message, nativeId) : [];
          const runId = yield* api(
            HermesApi.startRun(connection, {
              input: images.length
                ? [...(text ? [{ type: "text" as const, text }] : []), ...images]
                : text,
              sessionId: nativeSessionId!,
              ...(model ? { model } : {}),
              ...(provider ? { provider } : {}),
              ...(reasoningEffort ? { reasoningEffort } : {}),
              ...(fast === undefined ? {} : { fast }),
              instructions,
              idempotencyKey: nativeId,
            }),
          );
          turn.runId = runId;
          yield* followRun(turn, runId);
        }).pipe(
          Effect.onError((cause) => {
            const error = Cause.squash(cause);
            const detail =
              error instanceof ProviderAdapter.ProviderAdapterProtocolError
                ? error.detail
                : error instanceof Error
                  ? error.message
                  : "Hermes could not start the run.";
            const rejection =
              error instanceof ProviderAdapter.ProviderAdapterProtocolError &&
              error.payload instanceof HermesApi.HermesApiError
                ? error.payload
                : undefined;
            const log =
              hasImages && rejection && turn.runId === undefined
                ? Effect.logWarning("hermes.attachment.rejected", {
                    correlationId: nativeId,
                    endpoint: "/v1/runs",
                    category:
                      rejection.code === "body_too_large"
                        ? "body_too_large"
                        : rejection.status === undefined
                          ? "network"
                          : "http_rejected",
                    status: rejection.status,
                    code: rejection.code,
                  })
                : Effect.void;
            return log.pipe(
              Effect.andThen(eventPermit.withPermits(1)(finish(turn, "failed", detail))),
            );
          }),
        );
      });

      const snapshot = Effect.fnUntraced(function* (current: OrchestrationV2ProviderThread) {
        const sessionId = current.nativeThreadRef?.nativeId ?? nativeSessionId;
        if (!sessionId) return yield* protocolError("Hermes thread has no session");
        const messages = yield* api(HermesApi.listMessages(connection, sessionId));
        const now = yield* DateTime.now;
        return {
          providerThread: current,
          providerTurns: [],
          messages: messages.flatMap((message): OrchestrationV2ConversationMessage[] =>
            message.role === "user" || message.role === "assistant"
              ? [
                  {
                    id: idAllocator.derive.messageFromProviderItem({
                      driver: HERMES_PROVIDER,
                      nativeItemId: `${options.instanceId}:${current.id}:history:${message.id}`,
                    }),
                    threadId: current.appThreadId ?? input.threadId,
                    runId: null,
                    nodeId: null,
                    role: message.role,
                    text: message.content,
                    attachments: [],
                    streaming: false,
                    createdBy: message.role === "assistant" ? "agent" : "user",
                    creationSource: "provider",
                    createdAt: now,
                    updatedAt: now,
                  },
                ]
              : [],
          ),
          runtimeRequests: [...pending.values()].map((entry) => entry.request),
        } satisfies ProviderAdapter.ProviderAdapterV2ThreadSnapshot;
      });

      const activeRun = (
        providerTurnId: OrchestrationV2ProviderTurn["id"],
        providerThread: OrchestrationV2ProviderThread,
      ) => {
        const turn = active;
        return turn &&
          turn.providerTurn.id === providerTurnId &&
          validateThread(providerThread) &&
          turn.runId
          ? { turn, runId: turn.runId }
          : undefined;
      };

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: HERMES_PROVIDER,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromQueue(events),
        ensureThread: (args) =>
          register(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: HERMES_PROVIDER,
                  threadId: args.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (args) =>
          register({
            threadId: args.threadId ?? args.providerThread.appThreadId ?? input.threadId,
            modelSelection: args.modelSelection ?? input.modelSelection,
            runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: args.providerThread,
          }).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: HERMES_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: args.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: (args) =>
          start(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: HERMES_PROVIDER,
                  threadId: args.threadId,
                  providerThreadId: args.providerThread.id,
                  runId: args.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (args) =>
          Effect.gen(function* () {
            const target = activeRun(args.providerTurnId, args.providerThread);
            if (!target) return yield* protocolError("This Hermes run cannot be steered");
            // Hermes steers with text only. Nothing is sent, and the turn says so rather
            // than a failed steer the outbox would retry out of sight.
            if (args.message.attachments.some((attachment) => attachment.type === "image")) {
              yield* Effect.logWarning("hermes.attachment.rejected", {
                correlationId: target.turn.nativeId,
                messageId: args.message.messageId,
                attachmentIds: args.message.attachments.map((attachment) => attachment.id),
                category: "steer_unsupported",
              });
              return yield* eventPermit.withPermits(1)(
                notDelivered(target.turn, String(args.message.messageId)),
              );
            }
            const text = promptText(args.message);
            if (!text) return yield* protocolError("Hermes Agent needs a text message");
            yield* api(HermesApi.steerRun(connection, target.runId, text));
          }).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver: HERMES_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  providerTurnId: args.providerTurnId,
                  cause,
                }),
            ),
          ),
        interruptTurn: (args) =>
          Effect.gen(function* () {
            const target = activeRun(args.providerTurnId, args.providerThread);
            if (!target) return yield* protocolError("This Hermes run is no longer active");
            yield* api(HermesApi.stopRun(connection, target.runId));
            // Hermes confirms with `run.cancelled`; a stream that never says so still ends the turn.
            yield* Deferred.await(target.turn.done).pipe(
              Effect.timeout(30_000),
              Effect.catch(() => eventPermit.withPermits(1)(finish(target.turn, "interrupted"))),
            );
          }).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver: HERMES_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  providerTurnId: args.providerTurnId,
                  cause,
                }),
            ),
          ),
        respondToRuntimeRequest: (args) =>
          Effect.gen(function* () {
            const entry = pending.get(args.requestId);
            if (!entry?.turn.runId)
              return yield* protocolError("This Hermes request is no longer pending");
            const choice = args.decision && CHOICE_BY_DECISION[args.decision];
            if (!choice) return yield* protocolError("Hermes did not offer this decision");
            entry.response = { decision: args.decision };
            yield* api(
              HermesApi.answerApproval(connection, entry.turn.runId, choice, entry.nativeRequestId),
            ).pipe(Effect.tapError(() => Effect.sync(() => delete entry.response)));
            yield* eventPermit.withPermits(1)(resolvePending(entry, "resolved"));
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                  driver: HERMES_PROVIDER,
                  requestId: args.requestId,
                  cause,
                }),
            ),
          ),
        readThreadSnapshot: (args) =>
          (!validateThread(args.providerThread)
            ? Effect.fail(protocolError("Snapshot requested for a different Hermes thread"))
            : snapshot(args.providerThread)
          ).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                  driver: HERMES_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  cause,
                }),
            ),
          ),
        rollbackThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: HERMES_PROVIDER,
              providerThreadId: args.providerThread.id,
              checkpointId: args.target.checkpointId,
              cause: "Hermes Agent does not support conversation rollback in T3 Code.",
            }),
          ),
        forkThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: HERMES_PROVIDER,
              providerThreadId: args.sourceProviderThread.id,
              cause: "Hermes Agent does not support native forks in T3 Code.",
            }),
          ),
      };
      return runtime;
    }),
  });
});
