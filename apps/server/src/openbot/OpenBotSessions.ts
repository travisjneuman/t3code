/**
 * The OpenBot section's server side: `list` reads every conversation from openbot.db, read-only,
 * with the T3 thread bound to each; `open` opens one as a Scratch thread holding its history,
 * whose turns go to the same agent, and syncs what OpenBot added since; `newChat` makes a new
 * chat's thread, whose agent `setAgent` can change until its first message starts the chat in
 * OpenBot. Fork add-on; see docs/user/openbot.md.
 *
 * @module openbot/OpenBotSessions
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  isOpenBotNewChatThread,
  openBotNewChatThreadId,
  type OpenBotConversationSummary,
  OpenBotSessionsError,
  type OpenBotSessionsListInput,
  type OpenBotSessionsListResult,
  type OpenBotSessionsNewChatInput,
  type OpenBotSessionsOpenInput,
  type OpenBotSessionsOpenResult,
  type OpenBotSessionsSetAgentInput,
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
    readonly newChat: (
      input: OpenBotSessionsNewChatInput,
    ) => Effect.Effect<OpenBotSessionsOpenResult, OpenBotSessionsError>;
    readonly setAgent: (
      input: OpenBotSessionsSetAgentInput,
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
  const crypto = yield* Crypto.Crypto;
  const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;

  const commandId = (kind: string) =>
    crypto.randomUUIDv4().pipe(
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
   * This instance's threads by OpenBot conversation. A new chat binds another thread to the same
   * conversation, so the newest unarchived one wins; until its first message it binds nothing
   * and is pending. A started new chat supersedes the threads before it that saw no activity
   * since, such as by an unarchive.
   */
  const threadsOf = (instanceId: ProviderInstanceId) =>
    sql<{
      readonly thread_id: string;
      readonly native_id: string | null;
      readonly archived_at: string | null;
      readonly updated_at: string;
      readonly first_run_at: string | null;
    }>`
      SELECT p.thread_id AS thread_id,
        json_extract(p.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
        t.archived_at AS archived_at,
        t.updated_at AS updated_at,
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
        const pending: Array<{ threadId: ThreadId; agentId: string }> = [];
        const superseded: Array<ThreadId> = [];
        const live = new Map<string, Array<(typeof rows)[number]>>();
        for (const row of rows) {
          if (typeof row.native_id !== "string") continue;
          const archived = row.archived_at !== null;
          if (isOpenBotNewChatThread(row.thread_id) && row.first_run_at === null) {
            const agentId = OpenBotDb.agentOfThread(row.native_id);
            if (!archived && agentId !== undefined) {
              pending.push({ threadId: ThreadId.make(row.thread_id), agentId });
            }
            continue;
          }
          if (!archived) live.set(row.native_id, [...(live.get(row.native_id) ?? []), row]);
          if (archived && bound.get(row.native_id)?.archived === false) continue;
          bound.set(row.native_id, { threadId: ThreadId.make(row.thread_id), archived });
        }
        for (const threads of live.values()) {
          const winner = threads.at(-1);
          const startedAt = winner?.first_run_at;
          if (!winner || !startedAt || !isOpenBotNewChatThread(winner.thread_id)) continue;
          for (const thread of threads) {
            if (thread !== winner && thread.updated_at < startedAt) {
              superseded.push(ThreadId.make(thread.thread_id));
            }
          }
        }
        return { bound, pending, superseded };
      }),
      Effect.mapError(failed("Could not read T3's OpenBot threads.")),
    );
  const boundThreads = (instanceId: ProviderInstanceId) =>
    threadsOf(instanceId).pipe(Effect.map(({ bound }) => bound));

  const archiveThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: yield* commandId("archive"),
        threadId,
      });
    }).pipe(Effect.ignore({ log: true }));

  const list: OpenBotSessions["Service"]["list"] = Effect.fn("OpenBotSessions.list")(
    function* (input) {
      const { location, label } = yield* instanceOf(input.instanceId);
      const { agents, threads } = yield* OpenBotDb.readDirectory(location).pipe(
        Effect.mapError(fromOpenBot),
      );
      const { bound, pending, superseded } = yield* threadsOf(input.instanceId);
      // The earlier chat stays in T3, under Settings › Archive.
      yield* Effect.forEach(superseded, archiveThread, { discard: true });
      const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
      const withSides = new Set(
        threads.filter((thread) => thread.side).map((thread) => thread.agentId),
      );
      // An agent is listed once it has a conversation: messages, side threads or a T3 thread.
      const held = withMainConversations(agents, threads).filter(
        (thread) =>
          thread.side ||
          thread.messageCount > 0 ||
          withSides.has(thread.agentId) ||
          bound.has(thread.id),
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
        })),
        pendingChats: pending,
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

  /**
   * A new thread bound to the conversation: holding its whole history, or, for a new chat, empty
   * and with a provider thread of its own beside the earlier chat's.
   */
  const createThread = Effect.fn("OpenBotSessions.createThread")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly conversation: OpenBotDb.OpenBotThreadRecord;
    readonly agent: OpenBotDb.OpenBotAgentRecord;
    readonly entries: ReadonlyArray<OpenBotDb.OpenBotEntry>;
    readonly newChat?: boolean;
  }) {
    const { instanceId, threadId, conversation, agent, entries, newChat = false } = input;
    const { projectId } = yield* managedFolders.ensureScratchProject.pipe(
      Effect.mapError(failed("The Scratch project is unavailable.")),
    );
    const now = yield* DateTime.now;
    const startedAt = entries[0] === undefined ? now : DateTime.makeUnsafe(entries[0].atMs);
    const updatedMs = Date.parse(conversation.updatedAt);
    const updatedAt =
      !newChat && Number.isFinite(updatedMs) ? DateTime.makeUnsafe(updatedMs) : now;
    const providerThreadId = idAllocator.derive.providerThread({
      driver: OPENBOT_DRIVER,
      providerInstanceId: instanceId,
      nativeThreadId: newChat ? `${conversation.id}#${threadId}` : conversation.id,
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
      const importedId = ThreadId.make(`openbot:${instanceId}:${conversationId}`);
      const threadId = bound?.threadId ?? importedId;
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

      const { agent, entries } = yield* conversationOf(instanceId, conversationId);
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
      // A new chat's thread starts empty; what came before it is the earlier chat's.
      const startedMs =
        threadId === importedId ? 0 : DateTime.toEpochMillis(records.thread.createdAt);
      const added = entries.filter(
        (entry) =>
          entry.atMs >= startedMs &&
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

  /** The agent and its main conversation, if T3 can message it. */
  const sendableAgent = Effect.fn("OpenBotSessions.sendableAgent")(function* (
    instanceId: ProviderInstanceId,
    agentId: string | undefined,
  ) {
    const { location } = yield* instanceOf(instanceId);
    const { agents, threads } = yield* OpenBotDb.readDirectory(location).pipe(
      Effect.mapError(fromOpenBot),
    );
    const sendable = agents
      .filter((agent) => agent.localScripts)
      .toSorted((a, b) => a.name.localeCompare(b.name));
    const wanted = (agentId ?? location.defaultAgent).trim().toLowerCase();
    const agent = wanted
      ? sendable.find((candidate) =>
          [candidate.id, candidate.name, OpenBotDb.agentLabel(candidate)].some(
            (key) => key.toLowerCase() === wanted,
          ),
        )
      : sendable[0];
    const conversation =
      agent &&
      withMainConversations(agents, threads).find(
        (candidate) => candidate.id === OpenBotDb.mainThreadId(agent.id),
      );
    if (agent === undefined || !conversation) {
      return yield* new OpenBotSessionsError({
        message:
          agentId === undefined && sendable.length > 0
            ? `No OpenBot agent with Local scripts on is named "${location.defaultAgent}". Check Default agent in the provider's settings.`
            : "Turn on Local scripts for this agent in OpenBot to start a chat from T3 Code.",
      });
    }
    return { agent, conversation };
  });

  const setAgent: OpenBotSessions["Service"]["setAgent"] = Effect.fn("OpenBotSessions.setAgent")(
    function* (input) {
      const { instanceId, threadId } = input;
      const records = yield* orchestrator
        .getThreadRecords(threadId, ["runs", "providerThreads"])
        .pipe(Effect.mapError(failed("T3 has no such thread.")));
      const providerThread = records.providerThreads.find(
        (candidate) => candidate.id === records.thread.activeProviderThreadId,
      );
      if (
        !isOpenBotNewChatThread(threadId) ||
        records.runs.length > 0 ||
        providerThread === undefined ||
        providerThread.providerInstanceId !== instanceId
      ) {
        return yield* new OpenBotSessionsError({
          message: "A chat keeps its agent once it has started. Start a new chat to talk to another.",
        });
      }
      const opened = { threadId, projectId: records.thread.projectId };
      const { agent, conversation } = yield* sendableAgent(instanceId, input.agentId);
      if (providerThread.nativeThreadRef?.nativeId === conversation.id) return opened;
      const [eventKey, now] = [
        yield* crypto.randomUUIDv4().pipe(Effect.mapError(failed("Could not change the agent."))),
        yield* DateTime.now,
      ];
      yield* eventSink
        .write({
          events: [
            {
              id: EventId.make(
                `${IMPORT_EVENT_PREFIX}:provider-thread:${providerThread.id}:agent:${eventKey}`,
              ),
              type: "provider-thread.updated",
              threadId,
              driver: OPENBOT_DRIVER,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                ...providerThread,
                nativeThreadRef: {
                  driver: OPENBOT_DRIVER,
                  nativeId: conversation.id,
                  strength: "strong",
                },
                updatedAt: now,
              },
            },
          ],
        })
        .pipe(Effect.mapError(failed("Could not change the agent.")));
      yield* orchestrator
        .dispatch({
          type: "thread.model-selection.set",
          commandId: yield* commandId("model"),
          threadId,
          modelSelection: { instanceId, model: agentModel(agent) },
        })
        .pipe(Effect.ignore({ log: true }));
      yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: yield* commandId("title"),
          threadId,
          title: OpenBotDb.agentLabel(agent),
          expectedEmpty: true,
        })
        .pipe(Effect.ignore({ log: true }));
      return opened;
    },
  );

  const newChat: OpenBotSessions["Service"]["newChat"] = Effect.fn("OpenBotSessions.newChat")(
    function* (input) {
      const { instanceId, agentId } = input;
      // One pending chat per instance: + again returns to it, with its agent unless one is named.
      const [waiting] = (yield* threadsOf(instanceId)).pending;
      if (waiting !== undefined && agentId !== undefined) {
        return yield* setAgent({ instanceId, threadId: waiting.threadId, agentId });
      }
      if (waiting !== undefined) {
        const records = yield* orchestrator
          .getThreadRecords(waiting.threadId, [])
          .pipe(Effect.mapError(failed("Could not open the new chat.")));
        return { threadId: waiting.threadId, projectId: records.thread.projectId };
      }
      const { agent, conversation } = yield* sendableAgent(instanceId, agentId);
      const chatId = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError(failed("Could not start a new chat.")));
      return yield* createThread({
        instanceId,
        threadId: ThreadId.make(openBotNewChatThreadId(instanceId, chatId)),
        conversation,
        agent,
        entries: [],
        newChat: true,
      });
    },
  );

  return OpenBotSessions.of({ list, open, newChat, setAgent });
});

export const layer = Layer.effect(OpenBotSessions, make);
