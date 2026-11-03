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
import * as SecureRandom from "effect/crypto/SecureRandom";
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
const importedThreadId = (instanceId: ProviderInstanceId, conversationId: string) =>
  ThreadId.make(`openbot:${instanceId}:${conversationId}`);
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

/** The agent's provider and model as a model slug; its id when OpenBot names no pair. */
const agentModel = (agent: OpenBotDb.OpenBotAgentRecord) =>
  agent.provider && agent.model ? OpenBotDb.modelSlug(agent.provider, agent.model) : agent.id;

/**
 * The threads, plus an empty main conversation for each agent that has none yet but has side
 * threads to sit under it, or Local scripts on so T3 can start one.
 */
const withMainConversations = (
  agents: ReadonlyArray<OpenBotDb.OpenBotAgentRecord>,
  threads: ReadonlyArray<OpenBotDb.OpenBotThreadRecord>,
): ReadonlyArray<OpenBotDb.OpenBotThreadRecord> => {
  const listed = new Set(threads.map((thread) => thread.id));
  const withSides = new Set(threads.filter((thread) => thread.side).map((thread) => thread.agentId));
  const missing = agents.flatMap((agent): Array<OpenBotDb.OpenBotThreadRecord> => {
    const id = OpenBotDb.mainThreadId(agent.id);
    if (listed.has(id) || !(agent.localScripts || withSides.has(agent.id))) return [];
    return [
      {
        id,
        agentId: agent.id,
        title: agent.name,
        side: false,
        running: false,
        outcome: undefined,
        updatedAt: "",
        messageCount: 0,
      },
    ];
  });
  return missing.length === 0 ? threads : [...threads, ...missing];
};

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* SecureRandom.SecureRandom;
  const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;

  const commandId = (kind: string) =>
    crypto.uuidV4().pipe(
      Effect.map((id) => CommandId.make(`openbot-session-${kind}:${id}`)),
      Effect.mapError(failed("Could not update the thread.")),
    );

  /** The instance's settings and section title; only for an OpenBot instance. */
  const instanceOf = Effect.fn("OpenBotSessions.instanceOf")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(failed("Could not read settings.")),
    );
    const instance = settings.providerInstances[instanceId];
    if (instance === undefined || instance.driver !== OPENBOT_DRIVER) {
      return yield* new OpenBotSessionsError({ message: "That is not an OpenBot provider." });
    }
    const location = yield* Option.match(decodeOpenBotSettings(instance.config ?? {}), {
      onNone: () =>
        Effect.fail(new OpenBotSessionsError({ message: "The OpenBot settings are invalid." })),
      onSome: (decoded) => Effect.succeed(decoded),
    });
    // A name left at the driver's own label says nothing; the SSH host does.
    const displayName = instance.displayName?.trim();
    const label =
      (displayName && displayName.toLowerCase() !== "openbot" ? displayName : undefined) ||
      (location.sshHost ? `OpenBot · ${location.sshHost}` : "OpenBot");
    return { location, label };
  });

  /**
   * This instance's threads by OpenBot conversation, the newest unarchived one winning. Any but
   * the conversation's own import came from the retired New chat; one that never ran is empty, so
   * it binds nothing and the section leaves it out.
   */
  const boundThreads = (instanceId: ProviderInstanceId) =>
    sql<{
      readonly thread_id: string;
      readonly native_id: string | null;
      readonly archived_at: string | null;
      readonly first_run_at: string | null;
    }>`
      SELECT p.thread_id AS thread_id,
        json_extract(p.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
        t.archived_at AS archived_at,
        (SELECT MIN(r.requested_at) FROM orchestration_v2_projection_runs r
          WHERE r.thread_id = p.thread_id) AS first_run_at
      FROM orchestration_v2_projection_provider_threads p
      JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
      WHERE json_valid(p.payload_json)
        AND json_extract(p.payload_json, '$.driver') = ${OPENBOT_DRIVER}
        AND json_extract(p.payload_json, '$.providerInstanceId') = ${instanceId}
        AND t.deleted_at IS NULL
      ORDER BY t.created_at
    `.pipe(
      Effect.map((rows) => {
        const bound = new Map<string, { threadId: ThreadId; archived: boolean }>();
        for (const row of rows) {
          if (typeof row.native_id !== "string") continue;
          if (row.thread_id !== importedThreadId(instanceId, row.native_id) && !row.first_run_at)
            continue;
          const archived = row.archived_at !== null;
          if (archived && bound.get(row.native_id)?.archived === false) continue;
          bound.set(row.native_id, { threadId: ThreadId.make(row.thread_id), archived });
        }
        return bound;
      }),
      Effect.mapError(failed("Could not read T3's OpenBot threads.")),
    );

  const list: OpenBotSessions["Service"]["list"] = Effect.fn("OpenBotSessions.list")(
    function* (input) {
      const { location, label } = yield* instanceOf(input.instanceId);
      const { agents, threads } = yield* OpenBotDb.readDirectory(location).pipe(
        Effect.mapError(fromOpenBot),
      );
      const bound = yield* boundThreads(input.instanceId);
      const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
      const withSides = new Set(
        threads.filter((thread) => thread.side).map((thread) => thread.agentId),
      );
      // Listed once OpenBot holds messages or side threads for it; opening an empty one isn't enough.
      const held = withMainConversations(agents, threads).filter(
        (thread) => thread.side || thread.messageCount > 0 || withSides.has(thread.agentId),
      );
      const conversations = held.map(
        (thread): OpenBotConversationSummary => {
          const agent = agentsById.get(thread.agentId);
          const binding = bound.get(thread.id);
          const lastActiveAt = Date.parse(thread.updatedAt);
          return {
            id: thread.id,
            agentId: thread.agentId,
            agentName: agent?.name ?? thread.agentId,
            ...(agent?.title === undefined ? {} : { agentTitle: agent.title }),
            title: thread.title,
            side: thread.side,
            sendable: !thread.side && agent?.localScripts === true,
            running: thread.running,
            lastActiveAt: Number.isFinite(lastActiveAt) ? lastActiveAt : 0,
            messageCount: thread.messageCount,
            // An archived thread is taken up again by open, as a fresh pick.
            threadId: binding === undefined || binding.archived ? null : binding.threadId,
          };
        },
      );
      return {
        label,
        conversations,
        agents: agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          ...(agent.title === undefined ? {} : { title: agent.title }),
          sendable: agent.localScripts,
          conversationId: OpenBotDb.mainThreadId(agent.id),
        })),
      };
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
    const { location } = yield* instanceOf(instanceId);
    const { agents, threads, rows } = yield* OpenBotDb.readConversation(
      location,
      conversationId,
    ).pipe(Effect.mapError(fromOpenBot));
    const thread = withMainConversations(agents, threads).find(
      (candidate) => candidate.id === conversationId,
    );
    const agent = agents.find((candidate) => candidate.id === thread?.agentId);
    if (thread === undefined || agent === undefined) {
      return yield* new OpenBotSessionsError({ message: "OpenBot has no such conversation." });
    }
    const names = new Map(agents.map((each) => [each.id, each.name]));
    return { thread, agent, entries: conversationEntries(rows, names) };
  });

  /** One write for a batch of new entries, each placed after the T3 run before it. */
  const appendEntries = Effect.fn("OpenBotSessions.appendEntries")(function* (
    threadId: ThreadId,
    entries: ReadonlyArray<OpenBotDb.OpenBotEntry>,
    runs: ReadonlyArray<{ readonly ordinal: number; readonly startedAtMs: number }>,
  ) {
    if (entries.length === 0) return;
    const batch = yield* crypto
      .uuidV4()
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

  /** A new thread bound to the conversation, holding its whole history. */
  const createThread = Effect.fn("OpenBotSessions.createThread")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly conversation: OpenBotDb.OpenBotThreadRecord;
    readonly agent: OpenBotDb.OpenBotAgentRecord;
    readonly entries: ReadonlyArray<OpenBotDb.OpenBotEntry>;
  }) {
    const { instanceId, threadId, conversation, agent, entries } = input;
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
      title: conversation.side
        ? `${agent.name}: ${conversation.title}`
        : OpenBotDb.agentLabel(agent),
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: agentModel(agent) },
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
      const threadId = bound?.threadId ?? importedThreadId(instanceId, conversationId);
      const existing = yield* Effect.option(
        orchestrator.getThreadRecords(threadId, ["runs", "turnItems"]),
      );
      if (Option.isNone(existing)) {
        const { thread, agent, entries } = yield* conversationOf(instanceId, conversationId);
        return yield* createThread({ instanceId, threadId, conversation: thread, agent, entries });
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

      const { thread, agent, entries } = yield* conversationOf(instanceId, conversationId);
      // Imports from before the Name - Role label kept the bare name; a title set in T3 stays.
      const label = OpenBotDb.agentLabel(agent);
      if (!thread.side && records.thread.title === agent.name && label !== agent.name) {
        yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: yield* commandId("title"),
            threadId,
            title: label,
          })
          .pipe(Effect.ignore({ log: true }));
      }
      // OpenBot's own model control moves the agent too; the picker shows where it is now.
      const model = agentModel(agent);
      if (records.thread.modelSelection.model !== model) {
        yield* orchestrator
          .dispatch({
            type: "thread.model-selection.set",
            commandId: yield* commandId("model"),
            threadId,
            modelSelection: { instanceId, model },
          })
          .pipe(Effect.ignore({ log: true }));
      }
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
