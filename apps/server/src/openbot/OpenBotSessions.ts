/**
 * The OpenBot section's server side: `list` reads every conversation from openbot.db, read-only,
 * with the T3 thread bound to each; `open` opens one as a Scratch thread holding its history,
 * whose turns go to the same agent, and syncs what OpenBot added since. Fork add-on; see
 * docs/user/openbot.md.
 *
 * @module openbot/OpenBotSessions
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  type OpenBotConversationSummary,
  OpenBotSessionsError,
  type OpenBotSessionsListInput,
  type OpenBotSessionsListResult,
  type OpenBotSessionsOpenInput,
  type OpenBotSessionsOpenResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { OpenBotApi, OpenBotDb } from "@t3tools/provider-openbot/server";
import { OpenBotSettings } from "@t3tools/provider-openbot/settings";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import { conversationEntries, entryEvents, entryItemId } from "./openbotEntries.ts";

export class OpenBotSessions extends Context.Service<
  OpenBotSessions,
  {
    readonly list: (
      input: OpenBotSessionsListInput,
    ) => Effect.Effect<OpenBotSessionsListResult, OpenBotSessionsError>;
    readonly open: (
      input: OpenBotSessionsOpenInput,
    ) => Effect.Effect<OpenBotSessionsOpenResult, OpenBotSessionsError>;
  }
>()("t3/openbot/OpenBotSessions") {}

const OPENBOT_DRIVER = ProviderDriverKind.make("openbot");
const IMPORT_EVENT_PREFIX = "openbot-session-import:v1";
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
// A T3 turn's own rows land in the OpenBot conversation too; anything OpenBot
// stored inside a T3 run's window is that run's, already on screen.
const WINDOW_LEAD_MS = 30_000;
const WINDOW_TRAIL_MS = 30_000;

const decodeOpenBotSettings = Schema.decodeUnknownOption(OpenBotSettings);
const failed = (message: string) => (cause: unknown) =>
  new OpenBotSessionsError({ message, cause });
const fromOpenBot = (error: OpenBotApi.OpenBotError) =>
  new OpenBotSessionsError({ message: error.detail, cause: error });

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;

  const commandId = (kind: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((id) => CommandId.make(`openbot-session-${kind}:${id}`)),
      Effect.mapError(failed("Could not update the thread.")),
    );

  /** The instance's OpenBot folder; only for an OpenBot instance. */
  const configDirOf = Effect.fn("OpenBotSessions.configDirOf")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(failed("Could not read settings.")),
    );
    const instance = settings.providerInstances[instanceId];
    if (instance === undefined || instance.driver !== OPENBOT_DRIVER) {
      return yield* new OpenBotSessionsError({ message: "That is not an OpenBot provider." });
    }
    return yield* Option.match(decodeOpenBotSettings(instance.config ?? {}), {
      onNone: () =>
        Effect.fail(new OpenBotSessionsError({ message: "The OpenBot settings are invalid." })),
      onSome: (decoded) => Effect.succeed(OpenBotApi.configDirOf(decoded)),
    });
  });

  /** The live T3 thread bound to each OpenBot conversation of this instance. */
  const boundThreads = (instanceId: ProviderInstanceId) =>
    sql<{
      readonly thread_id: string;
      readonly native_id: string | null;
      readonly archived_at: string | null;
    }>`
      SELECT p.thread_id AS thread_id,
        json_extract(p.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
        t.archived_at AS archived_at
      FROM orchestration_v2_projection_provider_threads p
      JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
      WHERE json_valid(p.payload_json)
        AND json_extract(p.payload_json, '$.driver') = ${OPENBOT_DRIVER}
        AND json_extract(p.payload_json, '$.providerInstanceId') = ${instanceId}
        AND t.deleted_at IS NULL
    `.pipe(
      Effect.map((rows) => {
        const byNativeId = new Map<string, { threadId: ThreadId; archived: boolean }>();
        for (const row of rows) {
          if (typeof row.native_id !== "string") continue;
          byNativeId.set(row.native_id, {
            threadId: ThreadId.make(row.thread_id),
            archived: row.archived_at !== null,
          });
        }
        return byNativeId;
      }),
      Effect.mapError(failed("Could not read T3's OpenBot threads.")),
    );

  const list: OpenBotSessions["Service"]["list"] = Effect.fn("OpenBotSessions.list")(
    function* (input) {
      const configDir = yield* configDirOf(input.instanceId);
      const { agents, threads } = yield* OpenBotDb.readDirectory(configDir).pipe(
        Effect.mapError(fromOpenBot),
      );
      const bound = yield* boundThreads(input.instanceId);
      const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
      const conversations = threads.map((thread): OpenBotConversationSummary => {
        const agent = agentsById.get(thread.agentId);
        const binding = bound.get(thread.id);
        const lastActiveAt = Date.parse(thread.updatedAt);
        return {
          id: thread.id,
          agentId: thread.agentId,
          agentName: agent?.name ?? thread.agentId,
          title: thread.title,
          sendable: !thread.side && agent?.localScripts === true,
          running: thread.running,
          lastActiveAt: Number.isFinite(lastActiveAt) ? lastActiveAt : 0,
          messageCount: thread.messageCount,
          // An archived thread is taken up again by open, as a fresh pick.
          threadId: binding === undefined || binding.archived ? null : binding.threadId,
        };
      });
      return { conversations };
    },
  );

  const unarchiveThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const records = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
      if (Option.isNone(records) || records.value.thread.archivedAt === null) return;
      yield* orchestrator
        .dispatch({ type: "thread.unarchive", commandId: yield* commandId("unarchive"), threadId })
        .pipe(Effect.mapError(failed("Could not unarchive the thread.")));
    });

  const conversationOf = Effect.fn("OpenBotSessions.conversationOf")(function* (
    instanceId: ProviderInstanceId,
    conversationId: string,
  ) {
    const configDir = yield* configDirOf(instanceId);
    const { agents, threads } = yield* OpenBotDb.readDirectory(configDir).pipe(
      Effect.mapError(fromOpenBot),
    );
    const thread = threads.find((candidate) => candidate.id === conversationId);
    if (thread === undefined) {
      return yield* new OpenBotSessionsError({ message: "OpenBot has no such conversation." });
    }
    const names = new Map(agents.map((agent) => [agent.id, agent.name]));
    const rows = yield* OpenBotDb.readRows(configDir, conversationId).pipe(
      Effect.mapError(fromOpenBot),
    );
    return {
      thread,
      agentName: names.get(thread.agentId) ?? thread.agentId,
      entries: conversationEntries(rows, names),
    };
  });

  /** One write for a batch of new entries, each placed after the T3 run before it. */
  const appendEntries = Effect.fn("OpenBotSessions.appendEntries")(function* (
    threadId: ThreadId,
    entries: ReadonlyArray<OpenBotDb.OpenBotEntry>,
    runs: ReadonlyArray<{ readonly ordinal: number; readonly startedAtMs: number }>,
  ) {
    if (entries.length === 0) return;
    const batch = yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError(failed("Could not sync this conversation.")));
    const now = yield* DateTime.now;
    const events: OrchestrationV2DomainEvent[] = [];
    for (const entry of entries) {
      let band: number | undefined;
      for (const run of runs) {
        if (run.startedAtMs <= entry.atMs && (band === undefined || run.ordinal > band)) {
          band = run.ordinal;
        }
      }
      const ordinal = yield* positions
        .allocate({
          threadId,
          turnItemId: entryItemId(IMPORT_EVENT_PREFIX, threadId, entry.key),
          runId: null,
          ...(band === undefined ? {} : { runOrdinal: band }),
        })
        .pipe(Effect.mapError(failed("Could not sync this conversation.")));
      events.push(
        ...entryEvents({
          threadId,
          prefix: IMPORT_EVENT_PREFIX,
          entry,
          ordinal,
          batch,
          occurredAt: now,
        }),
      );
    }
    yield* eventSink
      .write({ events })
      .pipe(Effect.mapError(failed("Could not sync this conversation.")));
  });

  /** A new thread holding the whole conversation, bound to it. */
  const createThread = Effect.fn("OpenBotSessions.createThread")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly conversation: OpenBotDb.OpenBotThreadRecord;
    readonly agentName: string;
    readonly entries: ReadonlyArray<OpenBotDb.OpenBotEntry>;
  }) {
    const { instanceId, threadId, conversation, agentName, entries } = input;
    const { projectId } = yield* managedFolders.ensureScratchProject.pipe(
      Effect.mapError(failed("The Scratch project is unavailable.")),
    );
    const now = yield* DateTime.now;
    const startedAt = entries[0] === undefined ? now : DateTime.makeUnsafe(entries[0].atMs);
    const updatedMs = Date.parse(conversation.updatedAt);
    const updatedAt = Number.isFinite(updatedMs) ? DateTime.makeUnsafe(updatedMs) : now;
    const providerThreadId = idAllocator.derive.providerThread({
      driver: OPENBOT_DRIVER,
      providerInstanceId: instanceId,
      nativeThreadId: conversation.id,
    });
    const appThread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId,
      title: conversation.side ? `${agentName}: ${conversation.title}` : conversation.title,
      providerInstanceId: instanceId,
      // The model is the agent: each turn goes to the agent that owns this conversation.
      modelSelection: { instanceId, model: conversation.agentId },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: providerThreadId,
      historyOrigin: "native",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: startedAt,
      updatedAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver: OPENBOT_DRIVER,
      providerInstanceId: instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver: OPENBOT_DRIVER, nativeId: conversation.id, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt: startedAt,
      updatedAt,
    };
    const events: OrchestrationV2DomainEvent[] = [
      {
        id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
        type: "thread.created",
        threadId,
        providerInstanceId: instanceId,
        occurredAt: appThread.createdAt,
        payload: appThread,
      },
      ...entries.flatMap((entry, index) =>
        entryEvents({
          threadId,
          prefix: IMPORT_EVENT_PREFIX,
          entry,
          ordinal: index + 1,
          batch: "created",
          occurredAt: DateTime.makeUnsafe(entry.atMs),
        }),
      ),
      {
        id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}:${threadId}`),
        type: "provider-thread.updated",
        threadId,
        driver: OPENBOT_DRIVER,
        providerInstanceId: instanceId,
        occurredAt: updatedAt,
        payload: providerThread,
      },
    ];
    yield* eventSink
      .write({ events })
      .pipe(Effect.mapError(failed("Could not open this conversation in T3.")));
    return { threadId, projectId };
  });

  const openConversation: OpenBotSessions["Service"]["open"] = Effect.fn("OpenBotSessions.open")(
    function* (input) {
      const { instanceId, conversationId } = input;
      const bound = (yield* boundThreads(instanceId)).get(conversationId);
      const threadId = bound?.threadId ?? ThreadId.make(`openbot:${instanceId}:${conversationId}`);
      const existing = yield* Effect.option(
        orchestrator.getThreadRecords(threadId, ["runs", "turnItems"]),
      );
      if (Option.isNone(existing)) {
        const { thread, agentName, entries } = yield* conversationOf(instanceId, conversationId);
        return yield* createThread({
          instanceId,
          threadId,
          conversation: thread,
          agentName,
          entries,
        });
      }
      const records = existing.value;
      if (records.thread.deletedAt !== null) {
        return yield* new OpenBotSessionsError({
          message: "This conversation was opened in T3 before, and that thread was deleted.",
        });
      }
      yield* unarchiveThread(threadId);
      const opened = { threadId, projectId: records.thread.projectId };
      // A turn in flight writes its own items; the next open syncs the rest.
      if (records.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) return opened;

      const { entries } = yield* conversationOf(instanceId, conversationId);
      const written = new Set(records.turnItems.map((item) => item.id));
      const shownText = new Set(
        records.turnItems.flatMap((item) =>
          item.type === "user_message" || item.type === "assistant_message"
            ? [item.text.trim()]
            : [],
        ),
      );
      const windows = records.runs.flatMap((run) => {
        if (run.startedAt === null) return [];
        const requested = DateTime.toEpochMillis(run.requestedAt);
        const started = DateTime.toEpochMillis(run.startedAt);
        const completed =
          run.completedAt === null ? started : DateTime.toEpochMillis(run.completedAt);
        return [
          {
            start: Math.min(requested, started) - WINDOW_LEAD_MS,
            end: Math.max(completed, started) + WINDOW_TRAIL_MS,
          },
        ];
      });
      const added = entries.filter(
        (entry) =>
          !written.has(entryItemId(IMPORT_EVENT_PREFIX, threadId, entry.key)) &&
          !(entry.kind === "message" && shownText.has(entry.text.trim())) &&
          !windows.some((window) => entry.atMs >= window.start && entry.atMs <= window.end),
      );
      yield* appendEntries(
        threadId,
        added,
        records.runs.map((run) => ({
          ordinal: run.ordinal,
          startedAtMs: DateTime.toEpochMillis(run.startedAt ?? run.requestedAt),
        })),
      );
      return opened;
    },
  );

  // Two opens of one conversation at once would write the same import events
  // and fail; the second shares the first. Nothing is kept once it settles.
  const opening = yield* Cache.makeWith(
    (key: string) => {
      const [instanceId = "", conversationId = ""] = key.split("\u0000");
      return openConversation({ instanceId: ProviderInstanceId.make(instanceId), conversationId });
    },
    { capacity: 256, timeToLive: () => Duration.zero },
  );
  const open: OpenBotSessions["Service"]["open"] = (input) =>
    Cache.get(opening, `${input.instanceId}\u0000${input.conversationId}`);

  return OpenBotSessions.of({ list, open });
});

export const layer = Layer.effect(OpenBotSessions, make);
