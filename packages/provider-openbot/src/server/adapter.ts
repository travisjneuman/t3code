/**
 * OpenBot through its Local scripts API. Each T3 thread is one agent's main
 * conversation; a turn posts the message, follows its delivery, and reads the
 * rows OpenBot writes to openbot.db as turn items. OpenBot cannot be stopped,
 * steered or sent attachments from outside, so T3 refuses those honestly.
 */
import {
  isOpenBotNewChatThread,
  ProviderDriverKind,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type OrchestrationV2TurnItemStatus,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";

import type { OpenBotSettings } from "../settings.ts";
import * as OpenBotApi from "./api.ts";
import * as OpenBotDb from "./db.ts";

const OPENBOT_PROVIDER = ProviderDriverKind.make("openbot");
const POLL_MS = 2_000;
const MAX_POLL_ERRORS = 5;

/** A turn T3 refused before anything reached OpenBot; its message replaces the generic retry advice. */
class OpenBotTurnNotSentError extends Schema.TaggedError<OpenBotTurnNotSentError>()(
  "OpenBotTurnNotSentError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const OpenBotProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: false,
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
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: false,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "strong",
  },
  streaming: {
    // Rows arrive as OpenBot settles them, every couple of seconds, not as deltas.
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: false,
    emitsToolCompleted: true,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
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
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    // OpenBot's agents work in OpenBot's own folders; T3 has no files of theirs to checkpoint.
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "weak",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface OpenBotAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OpenBotSettings;
}

interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly nativeId: string;
  readonly agentId: string;
  readonly nativeThreadId: string;
  readonly sentAtMs: number;
  readonly names: ReadonlyMap<string, string>;
  readonly ordinals: Map<string, number>;
  readonly started: Map<string, DateTime.Utc>;
  readonly done: Deferred.Deferred<void>;
  nextOrdinal: number;
  sawAnswer: boolean;
  noticedPending: boolean;
}

const nativeRef = (nativeId: string, strength: "strong" | "weak" = "weak") => ({
  driver: OPENBOT_PROVIDER,
  nativeId,
  strength,
});

const WATCH_ONLY =
  "OpenBot's Local scripts reach only an agent's main conversation, so T3 Code can watch this side thread but not send to it.";
const NO_STOP = "OpenBot has no way to stop or steer a running message from outside; stop it in OpenBot.";

/** One OpenBot agent conversation per T3 thread; the orchestrator owns runs and queuing. */
export const makeOpenBotAdapterV2 = Effect.fn("makeOpenBotAdapterV2")(function* (
  options: OpenBotAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const providerHost = yield* ProviderHost.ProviderHost;
  const location = options.settings;
  const capabilities: OrchestrationV2ProviderCapabilities = OpenBotProviderCapabilitiesV2;

  const protocolError = (detail: string, payload?: unknown, cause?: OpenBotTurnNotSentError) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: OPENBOT_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
      ...(cause === undefined ? {} : { cause }),
    });
  const notSentError = (detail: string, payload?: unknown) =>
    protocolError(detail, payload, new OpenBotTurnNotSentError({ detail }));
  const openbot = <A>(effect: Effect.Effect<A, OpenBotApi.OpenBotError>) =>
    effect.pipe(Effect.mapError((error) => protocolError(error.detail, error)));

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: OPENBOT_PROVIDER,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("OpenBotAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      if (!options.settings.enabled) return yield* protocolError("OpenBot is disabled");
      const scope = yield* Effect.scope;
      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: OPENBOT_PROVIDER,
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
      let nativeThreadId: string | undefined;
      let thread: OrchestrationV2ProviderThread | undefined;
      let active: ActiveTurn | undefined;

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) {
        session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_session.updated",
          driver: OPENBOT_PROVIDER,
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
          driver: OPENBOT_PROVIDER,
          providerThread: thread,
        });
      });

      // OpenBot message ids are unique, so items are keyed by them rather than by turn.
      const itemIdentity = (turn: ActiveTurn, nativeId: string) =>
        `${options.instanceId}:${turn.input.providerThread.id}:${nativeId}`;
      const baseItem = (turn: ActiveTurn, nativeId: string, time: DateTime.Utc) => {
        if (!turn.ordinals.has(nativeId)) turn.ordinals.set(nativeId, turn.nextOrdinal++);
        if (!turn.started.has(nativeId)) turn.started.set(nativeId, time);
        const identity = itemIdentity(turn, nativeId);
        return {
          id: idAllocator.derive.turnItemFromProviderItem({
            driver: OPENBOT_PROVIDER,
            nativeItemId: identity,
          }),
          nodeId: idAllocator.derive.nodeFromProviderItem({
            driver: OPENBOT_PROVIDER,
            nativeItemId: identity,
          }),
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: nativeRef(nativeId, "strong"),
          parentItemId: null,
          ordinal: turn.ordinals.get(nativeId)!,
          startedAt: turn.started.get(nativeId)!,
          updatedAt: time,
        };
      };

      /** Publishes one row: its execution node and its turn item. */
      const publishRow = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        base: ReturnType<typeof baseItem>,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2TurnItemStatus,
        turnItem: OrchestrationV2TurnItem,
      ) {
        yield* emit({
          type: "node.updated",
          driver: OPENBOT_PROVIDER,
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
            nativeItemRef: base.nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: base.startedAt,
            completedAt: base.updatedAt,
          },
        });
        yield* emit({ type: "turn_item.updated", driver: OPENBOT_PROVIDER, turnItem });
      });

      const publishMessage = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        nativeId: string,
        text: string,
      ) {
        const time = yield* DateTime.now;
        const base = baseItem(turn, nativeId, time);
        const messageId = idAllocator.derive.messageFromProviderItem({
          driver: OPENBOT_PROVIDER,
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
          streaming: false,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: base.startedAt,
          updatedAt: time,
        };
        yield* emit({ type: "message.updated", driver: OPENBOT_PROVIDER, message });
        yield* publishRow(turn, base, "assistant_message", "completed", {
          ...base,
          type: "assistant_message",
          status: "completed",
          title: null,
          completedAt: time,
          messageId,
          text,
          streaming: false,
        });
      });

      const publishNotice = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        nativeId: string,
        message: string,
      ) {
        const time = yield* DateTime.now;
        const base = baseItem(turn, nativeId, time);
        yield* publishRow(turn, base, "system", "completed", {
          ...base,
          type: "system_notice",
          status: "completed",
          title: null,
          completedAt: time,
          message,
        });
      });

      const publishEntry = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        entry: OpenBotDb.OpenBotEntry,
      ) {
        if (entry.kind === "message") {
          if (entry.role === "user") return;
          turn.sawAnswer = true;
          return yield* publishMessage(turn, entry.key, entry.text);
        }
        if (entry.kind === "notice") return yield* publishNotice(turn, entry.key, entry.text);
        const time = yield* DateTime.now;
        const base = baseItem(turn, entry.key, time);
        if (entry.kind === "reasoning")
          return yield* publishRow(turn, base, "reasoning", "completed", {
            ...base,
            type: "reasoning",
            status: "completed",
            title: null,
            completedAt: time,
            text: entry.text,
            streaming: false,
          });
        const status = entry.failed ? "failed" : "completed";
        const common = { ...base, status, title: entry.title, completedAt: time } as const;
        yield* publishRow(
          turn,
          base,
          "tool_call",
          status,
          entry.command === undefined
            ? { ...common, type: "dynamic_tool", toolName: entry.title, input: null }
            : {
                ...common,
                type: "command_execution",
                input: entry.command,
                ...(entry.failed ? { outputIndicatesFailure: true } : {}),
              },
        );
      });

      const finish = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        status: "completed" | "cancelled" | "interrupted" | "failed",
        detail?: string,
      ) {
        if (active !== turn) return;
        const completedAt = yield* DateTime.now;
        turn.providerTurn = { ...turn.providerTurn, status, completedAt };
        yield* emit({
          type: "provider_turn.updated",
          driver: OPENBOT_PROVIDER,
          threadId: turn.input.threadId,
          providerTurn: turn.providerTurn,
        });
        yield* updateThread({ status: "idle" });
        yield* updateSession("ready", detail ?? null);
        active = undefined;
        if (status === "failed") {
          const failure = makeProviderFailure({
            class: "provider_error",
            message: detail ?? "OpenBot could not deliver the message.",
          });
          const base = baseItem(turn, `failure:${turn.nativeId}`, completedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: OPENBOT_PROVIDER,
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
            driver: OPENBOT_PROVIDER,
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
            driver: OPENBOT_PROVIDER,
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

      const pollOnce = (turn: ActiveTurn, deliveryId: string, sequence: number) =>
        Effect.gen(function* () {
          const delivery = yield* OpenBotApi.getDelivery(location, turn.agentId, deliveryId);
          const rows = yield* OpenBotDb.readRows(location, turn.nativeThreadId, sequence);
          const ended = OpenBotApi.ENDED_DELIVERY_STATUSES.has(delivery.status);
          const waiting =
            ended || turn.noticedPending
              ? 0
              : yield* OpenBotApi.pendingCount(location, turn.agentId).pipe(
                  Effect.orElseSucceed(() => 0),
                );
          return { delivery, rows, ended, waiting };
        });

      /** Follows the delivery the way OpenBot's own CLI does, publishing rows as they settle. */
      const follow = (turn: ActiveTurn, deliveryId: string, baseline: number) =>
        Effect.gen(function* () {
          let sequence = baseline;
          let errors = 0;
          while (true) {
            yield* Effect.sleep(POLL_MS);
            if (active !== turn || closed) return;
            const result = yield* pollOnce(turn, deliveryId, sequence).pipe(
              Effect.catch((error) => Effect.succeed(error)),
            );
            if (result instanceof OpenBotApi.OpenBotError) {
              if (++errors < MAX_POLL_ERRORS) continue;
              return yield* eventPermit.withPermits(1)(
                finish(turn, "failed", `T3 Code lost track of OpenBot: ${result.detail}`),
              );
            }
            errors = 0;
            const done = yield* Effect.gen(function* () {
              if (active !== turn) return true;
              for (const row of result.rows) {
                sequence = Math.max(sequence, row.sequence);
                // The user's own message is already in T3; older rows only changed state.
                if (!row.settled || row.author === "user") continue;
                if (Date.parse(row.createdAt) < turn.sentAtMs - 1_000) continue;
                for (const entry of OpenBotDb.rowEntries(row, turn.names))
                  yield* publishEntry(turn, entry);
              }
              if (result.waiting > 0 && !turn.noticedPending) {
                turn.noticedPending = true;
                yield* publishNotice(
                  turn,
                  `${turn.nativeId}:pending`,
                  "OpenBot is waiting for you: answer its question or approval in OpenBot, and this turn continues.",
                );
              }
              if (!result.ended) return false;
              const { delivery } = result;
              if (delivery.status === "completed") {
                if (!turn.sawAnswer && delivery.answer?.trim())
                  yield* publishMessage(turn, `${turn.nativeId}:answer`, delivery.answer.trim());
                yield* finish(turn, "completed");
              } else if (delivery.status === "failed") {
                yield* finish(turn, "failed", delivery.error ?? "OpenBot reported the message failed.");
              } else {
                yield* finish(turn, "interrupted", delivery.error ?? "Stopped in OpenBot.");
              }
              return true;
            }).pipe(eventPermit.withPermits(1));
            if (done) return;
          }
        });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          // OpenBot keeps working on the message; only T3's view of it ends here.
          if (active) yield* finish(active, "cancelled", "OpenBot session closed");
          yield* Queue.shutdown(events);
        }).pipe(eventPermit.withPermits(1)),
      );

      const register = Effect.fnUntraced(function* (
        args: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        if (closed) return yield* protocolError("OpenBot session is closed; reopen it");
        if (active)
          return yield* protocolError("Cannot change OpenBot conversations during an active turn");
        const existing = args.existingProviderThread;
        if (
          existing &&
          (existing.driver !== OPENBOT_PROVIDER ||
            existing.providerInstanceId !== options.instanceId)
        )
          return yield* protocolError("OpenBot thread belongs to another provider instance");
        const requestedId = existing
          ? (existing.nativeThreadRef?.nativeId ?? undefined)
          : input.initialNativeThreadId;
        if (
          thread &&
          (!requestedId || requestedId === nativeThreadId) &&
          thread.appThreadId === args.threadId
        )
          return thread;
        if (thread)
          return yield* protocolError("Open a new session to attach another OpenBot conversation");
        // Threads from before models were provider and model pairs carry the agent as the model.
        const legacyAgent = args.modelSelection.model.startsWith("agent-")
          ? args.modelSelection.model
          : undefined;
        const chosenId =
          requestedId ?? (legacyAgent ? OpenBotDb.mainThreadId(legacyAgent) : undefined);
        if (!chosenId)
          return yield* protocolError(
            "Open an OpenBot agent's conversation from the OpenBot section of the sidebar to message it.",
          );
        nativeThreadId = chosenId;
        const createdAt = yield* DateTime.now;
        thread = existing
          ? {
              ...existing,
              providerSessionId: input.providerSessionId,
              nativeThreadRef: nativeRef(nativeThreadId, "strong"),
              status: "idle",
              updatedAt: createdAt,
            }
          : {
              id: idAllocator.derive.providerThread({
                driver: OPENBOT_PROVIDER,
                providerInstanceId: options.instanceId,
                nativeThreadId,
              }),
              driver: OPENBOT_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: args.threadId,
              ownerNodeId: null,
              nativeThreadRef: nativeRef(nativeThreadId, "strong"),
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
          driver: OPENBOT_PROVIDER,
          providerThread: thread,
        });
        return thread;
      });

      const validateThread = (candidate: OrchestrationV2ProviderThread) =>
        thread !== undefined &&
        candidate.driver === OPENBOT_PROVIDER &&
        candidate.providerInstanceId === options.instanceId &&
        candidate.appThreadId === thread.appThreadId;

      const start = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        if (!validateThread(turnInput.providerThread) || closed || !nativeThreadId)
          return yield* protocolError("OpenBot thread is not attached to this session");
        if (active)
          return yield* protocolError(
            "OpenBot already has an active turn; queue through the orchestrator",
          );
        const selection = turnInput.modelSelection;
        if (selection.instanceId !== options.instanceId)
          return yield* protocolError("Model selection belongs to another OpenBot instance");
        const agentId = OpenBotDb.agentOfThread(nativeThreadId);
        if (!agentId) return yield* notSentError(WATCH_ONLY);
        if (turnInput.message.attachments.length > 0)
          return yield* notSentError(
            "OpenBot's Local scripts take text only. Remove the attachments and send again.",
          );
        const text = turnInput.message.text.trim();
        if (!text) return yield* notSentError("OpenBot needs a text message");
        const readContext = OpenBotDb.turnContext(location, agentId).pipe(
          Effect.mapError((error) => notSentError(error.detail, error)),
        );
        let context = yield* readContext;
        // A new chat's first message starts it in OpenBot, as OpenBot's own New chat does.
        if (
          isOpenBotNewChatThread(turnInput.threadId) &&
          turnInput.providerThread.firstRunOrdinal === null &&
          context.messageCount > 0
        ) {
          yield* OpenBotApi.clearContext(location, agentId).pipe(
            Effect.mapError((error) => notSentError(error.detail, error)),
          );
          context = yield* readContext;
        }
        const chosen = OpenBotDb.parseModelSlug(selection.model);
        const effort = getModelSelectionStringOptionValue(selection, "reasoningEffort");
        const change: OpenBotApi.OpenBotAgentSettings = {
          ...(chosen && (chosen.provider !== context.provider || chosen.model !== context.model)
            ? chosen
            : {}),
          ...(effort && effort !== context.reasoningEffort ? { reasoningEffort: effort } : {}),
        };
        if (Object.keys(change).length > 0)
          yield* OpenBotApi.setAgentSettings(location, agentId, change).pipe(
            Effect.mapError((error) => notSentError(error.detail, error)),
          );
        const nativeId = String(turnInput.attemptId);
        const startedAt = yield* DateTime.now;
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: idAllocator.derive.providerTurn({
            driver: OPENBOT_PROVIDER,
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
          agentId,
          nativeThreadId,
          sentAtMs: DateTime.toEpochMillis(startedAt),
          names: context.names,
          ordinals: new Map(),
          started: new Map(),
          done: yield* Deferred.make<void>(),
          nextOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
          sawAnswer: false,
          noticedPending: false,
        };
        yield* Effect.gen(function* () {
          thread = turnInput.providerThread;
          active = turn;
          session = { ...session, model: selection.model };
          yield* emit({
            type: "provider_turn.updated",
            driver: OPENBOT_PROVIDER,
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
        yield* Effect.gen(function* () {
          const deliveryId = yield* OpenBotApi.sendMessage(location, agentId, text, nativeId).pipe(
            Effect.mapError((error) => notSentError(error.detail, error)),
          );
          yield* follow(turn, deliveryId, context.sequence).pipe(Effect.forkIn(scope));
        }).pipe(
          Effect.onError((cause) => {
            const error = Cause.squash(cause);
            const detail =
              error instanceof ProviderAdapter.ProviderAdapterProtocolError
                ? error.detail
                : error instanceof Error
                  ? error.message
                  : "OpenBot could not take the message.";
            return eventPermit.withPermits(1)(finish(turn, "failed", detail));
          }),
        );
      });

      const snapshot = Effect.fnUntraced(function* (current: OrchestrationV2ProviderThread) {
        const threadId = current.nativeThreadRef?.nativeId ?? nativeThreadId;
        if (!threadId) return yield* protocolError("OpenBot thread has no conversation");
        const { rows, names } = yield* openbot(OpenBotDb.readHistory(location, threadId));
        const now = yield* DateTime.now;
        return {
          providerThread: current,
          providerTurns: [],
          messages: rows
            .filter((row) => row.settled)
            .flatMap((row) => OpenBotDb.rowEntries(row, names))
            .flatMap((entry): OrchestrationV2ConversationMessage[] =>
              entry.kind === "message"
                ? [
                    {
                      id: idAllocator.derive.messageFromProviderItem({
                        driver: OPENBOT_PROVIDER,
                        nativeItemId: `${options.instanceId}:${current.id}:history:${entry.key}`,
                      }),
                      threadId: current.appThreadId ?? input.threadId,
                      runId: null,
                      nodeId: null,
                      role: entry.role,
                      text: entry.text,
                      attachments: [],
                      streaming: false,
                      createdBy: entry.role === "assistant" ? "agent" : "user",
                      creationSource: "provider",
                      createdAt: now,
                      updatedAt: now,
                    },
                  ]
                : [],
            ),
          runtimeRequests: [],
        } satisfies ProviderAdapter.ProviderAdapterV2ThreadSnapshot;
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: OPENBOT_PROVIDER,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromQueue(events),
        ensureThread: (args) =>
          register(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: OPENBOT_PROVIDER,
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
                  driver: OPENBOT_PROVIDER,
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
                  driver: OPENBOT_PROVIDER,
                  threadId: args.threadId,
                  providerThreadId: args.providerThread.id,
                  runId: args.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunError({
              driver: OPENBOT_PROVIDER,
              providerThreadId: args.providerThread.id,
              providerTurnId: args.providerTurnId,
              cause: protocolError(NO_STOP),
            }),
          ),
        interruptTurn: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterInterruptError({
              driver: OPENBOT_PROVIDER,
              providerThreadId: args.providerThread.id,
              providerTurnId: args.providerTurnId,
              cause: protocolError(NO_STOP),
            }),
          ),
        respondToRuntimeRequest: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
              driver: OPENBOT_PROVIDER,
              requestId: args.requestId,
              cause: protocolError("Answer OpenBot's questions and approvals in OpenBot."),
            }),
          ),
        readThreadSnapshot: (args) =>
          (!validateThread(args.providerThread)
            ? Effect.fail(protocolError("Snapshot requested for a different OpenBot thread"))
            : snapshot(args.providerThread)
          ).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                  driver: OPENBOT_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  cause,
                }),
            ),
          ),
        rollbackThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: OPENBOT_PROVIDER,
              providerThreadId: args.providerThread.id,
              checkpointId: args.target.checkpointId,
              cause: "OpenBot does not support conversation rollback in T3 Code.",
            }),
          ),
        forkThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: OPENBOT_PROVIDER,
              providerThreadId: args.sourceProviderThread.id,
              cause: "OpenBot does not support native forks in T3 Code.",
            }),
          ),
      };
      return runtime;
    }),
  });
});
