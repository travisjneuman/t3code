/**
 * Continue an external session in T3, in place: the thread binds the
 * provider's own session (same id, same files, same config home), so its next
 * turn resumes that session and the user can go back to the other app later.
 * Claude and Codex threads match `AgentSessionImporter` (same thread id,
 * runtime row, imported-transcript record); Grok and Pi threads are built the
 * same way from this add-on's own transcript parsers. Unlike the importer,
 * the thread starts active rather than settled, and its history is "native"
 * so the first turn resumes instead of also replaying it as a context
 * handoff.
 *
 * Handing a session to a different agent is the other way in: a new thread
 * per handoff, on the chosen instance, with no provider thread and history
 * marked "v1_import", so the first turn carries the history as imported
 * context (Orchestrator prepareLegacyImport). Nothing binds the original
 * session, and the sync never follows these threads. Fork add-on; see
 * docs/internals/external-sessions.md.
 *
 * @module external-sessions/continueExternalSession
 */
import { Buffer } from "node:buffer";
import * as NodeOS from "node:os";

import {
  ClaudeSettings,
  CodexSettings,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  ExternalSessionError,
  ExternalSessionUnsupportedError,
  type ExternalSessionContinueResult,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  resolveProviderInstanceEnabled,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { expandHomePath } from "../pathExpansion.ts";
import {
  type AgentSessionThreadMessage,
  parseAgentSessionTranscript,
} from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import { asString, parseJsonObject, type TranscriptParser } from "./ExternalSessionSource.ts";

// Same prefix and id shapes as AgentSessionImporter, so a session continued
// here and one imported during onboarding are the same thread.
const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const HANDOFF_EVENT_PREFIX = "external-session-handoff:v1";
// Never `import:`, so a handoff cannot collide with the thread continued in place.
const HANDOFF_THREAD_PREFIX = "external-handoff";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// The parser holds the whole transcript in memory; past this it is not worth it.
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
// Same retention as the importer: the first prompt plus the newest messages.
const MAX_HISTORY_MESSAGES = 200;

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

export type ContinueDriver = "claudeAgent" | "codex" | "grok" | "pi";

export interface ContinueTarget {
  readonly key: string;
  readonly driver: ContinueDriver;
  readonly sessionId: string;
  readonly title: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly transcriptPath: string;
  readonly updatedAtMs: number;
  /** The listing's own parser; history for drivers the importer does not read. */
  readonly createParser: () => TranscriptParser;
}

interface ContinueHistory {
  readonly providerSessionId: string;
  readonly model: string | null;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<AgentSessionThreadMessage>;
}

/**
 * Where the sync (externalSessionSync.ts) takes over: the transcript bytes
 * continue already imported end at `offset`, on a line boundary.
 */
export interface ContinueSyncStart {
  readonly threadId: ThreadId;
  readonly driver: ContinueDriver;
  /** The native session id, as in the thread id. */
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly offset: number;
}

/** `syncStart` is null when the thread already existed. */
export type ContinueOutcome = ExternalSessionContinueResult & {
  readonly syncStart: ContinueSyncStart | null;
};

/** The agent a handoff goes to: an enabled instance of a different driver. */
export interface HandoffTo {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}

export const isContinueDriver = (driver: string): driver is ContinueDriver =>
  driver === "claudeAgent" || driver === "codex" || driver === "grok" || driver === "pi";

const failed = (cause: unknown) =>
  new ExternalSessionError({ message: "Could not continue this session in T3.", cause });

function messageEvents(input: {
  readonly prefix: string;
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const suffix = String(input.index).padStart(6, "0");
  return importedMessageEvents({
    threadId: input.threadId,
    messageId: MessageId.make(`${input.threadId}:${suffix}`),
    turnItemId: TurnItemId.make(`${input.prefix}:turn-item:${input.threadId}:${suffix}`),
    eventId: (kind) => EventId.make(`${input.prefix}:${kind}:${input.threadId}:${suffix}`),
    ordinal: input.index + 1,
    message: input.message,
  });
}

/**
 * A runless, completed user or assistant message: the shape continue gives
 * the imported history and the sync (externalSessionSync.ts) gives messages
 * the other app adds later. Upserted by message and turn-item id.
 */
export function importedMessageEvents(input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly turnItemId: TurnItemId;
  readonly eventId: (kind: "message" | "turn-item") => EventId;
  readonly ordinal: number;
  readonly message: AgentSessionThreadMessage;
  /** When the event is recorded; the message's own time when omitted. */
  readonly occurredAt?: DateTime.Utc;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const messageId = input.messageId;
  const turnItemId = input.turnItemId;
  const at = DateTime.makeUnsafe(input.message.createdAt);
  const occurredAt = input.occurredAt ?? at;
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: input.eventId("message"),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt,
      payload: message,
    },
    {
      id: input.eventId("turn-item"),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt,
      payload: turnItem,
    },
  ];
}

const threadCreated = (
  prefix: string,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  appThread: OrchestrationV2AppThread,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`${prefix}:thread:${threadId}:created`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: appThread.createdAt,
  payload: appThread,
});

const providerThreadUpdated = (
  threadId: ThreadId,
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  providerThread: OrchestrationV2ProviderThread,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThread.id}`),
  type: "provider-thread.updated",
  threadId,
  driver,
  providerInstanceId,
  occurredAt: providerThread.updatedAt,
  payload: providerThread,
});

/**
 * History for Grok and Pi from the listing's parser: user and assistant
 * messages only, upserted by id the way the live view upserts them.
 */
function parsedHistory(target: ContinueTarget, contents: string): ContinueHistory | null {
  const parser = target.createParser();
  const byId = new Map<string, AgentSessionThreadMessage>();
  for (const line of contents.split("\n")) {
    for (const message of parser.push(line)) {
      if (message.role === "tool") continue;
      byId.set(message.id, {
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
      });
    }
  }
  const all = [...byId.values()];
  if (all.length === 0) return null;
  const firstUser = all.find((message) => message.role === "user");
  const messages =
    all.length <= MAX_HISTORY_MESSAGES
      ? all
      : firstUser === undefined || all.indexOf(firstUser) >= all.length - MAX_HISTORY_MESSAGES
        ? all.slice(-MAX_HISTORY_MESSAGES)
        : [firstUser, ...all.slice(-(MAX_HISTORY_MESSAGES - 1))];
  const updatedAt = new Date(target.updatedAtMs).toISOString();
  return {
    providerSessionId: target.sessionId,
    model: target.model,
    title: target.title,
    createdAt: messages[0]?.createdAt ?? updatedAt,
    updatedAt,
    messages,
  };
}

/**
 * The newest main-chain entry of a Claude transcript. Resuming at it makes
 * the first T3 turn `resume` the session itself; without a head, the adapter
 * opens a session it has no turns for with `sessionId`, which Claude refuses
 * for an id that already exists.
 */
function claudeLeafUuid(contents: string): string | null {
  let end = contents.length;
  while (end > 0) {
    const start = contents.lastIndexOf("\n", end - 1) + 1;
    const record = parseJsonObject(contents.slice(start, end).trim());
    end = start - 1;
    if (record === null || record.isSidechain === true) continue;
    if (record.type !== "user" && record.type !== "assistant") continue;
    const uuid = asString(record.uuid);
    if (uuid !== null) return uuid;
  }
  return null;
}

const isUnder = (path: Path.Path, child: string, root: string) => {
  const relative = path.relative(root, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const hostEnvironment = yield* HostProcessEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

  /**
   * The provider instance that resumes this session, chosen the way
   * AgentSessionScanner chooses the owner of a shared home: enabled instances
   * of the driver, the built-in one first, and the first whose home holds
   * the transcript. Pi has no home setting (its state is always
   * `~/.pi/agent`), so any enabled Pi instance can resume it.
   */
  const resolveInstance = Effect.fn("ExternalSessions.resolveInstance")(function* (
    target: ContinueTarget,
  ) {
    const source = target.driver;
    const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(failed));
    const instances: Array<{
      readonly instanceId: ProviderInstanceId;
      readonly config: ProviderInstanceConfig;
    }> = Object.entries(settings.providerInstances)
      .filter(
        ([, instance]) => instance.driver === source && resolveProviderInstanceEnabled(instance),
      )
      .map(([instanceId, config]) => ({ instanceId: ProviderInstanceId.make(instanceId), config }));
    if (!Object.hasOwn(settings.providerInstances, source)) {
      const legacy = {
        instanceId: ProviderInstanceId.make(source),
        config: { driver: ProviderDriverKind.make(source), config: settings.providers[source] },
      };
      if (resolveProviderInstanceEnabled(legacy.config)) instances.push(legacy);
    }
    instances.sort(
      (left, right) => (left.instanceId === source ? 0 : 1) - (right.instanceId === source ? 0 : 1),
    );
    if (source === "pi") {
      const first = instances[0];
      if (first !== undefined) return first.instanceId;
      return yield* new ExternalSessionUnsupportedError({ key: target.key, reason: "no-instance" });
    }

    const transcript = yield* realPath(target.transcriptPath);
    for (const { instanceId, config: instance } of instances) {
      const homeVariable =
        source === "claudeAgent"
          ? "CLAUDE_CONFIG_DIR"
          : source === "codex"
            ? "CODEX_HOME"
            : "GROK_HOME";
      // The spawned CLI sees the instance environment over the host's.
      const environmentHome =
        instance.environment?.findLast((variable) => variable.name === homeVariable)?.value ??
        hostEnvironment[homeVariable];
      const fromEnvironment = environmentHome?.trim() ?? "";
      let homePath: string;
      if (source === "claudeAgent") {
        const config = decodeClaudeSettings(instance.config ?? {});
        if (Option.isNone(config)) continue;
        const configured = config.value.homePath.trim();
        homePath =
          configured.length > 0
            ? path.resolve(expandHomePath(configured))
            : fromEnvironment.length > 0
              ? path.resolve(expandHomePath(fromEnvironment))
              : path.join(NodeOS.homedir(), ".claude");
      } else if (source === "codex") {
        const config = decodeCodexSettings(instance.config ?? {});
        if (Option.isNone(config)) continue;
        const codexSettings =
          config.value.homePath.trim().length === 0 &&
          config.value.shadowHomePath.trim().length === 0 &&
          fromEnvironment.length > 0
            ? { ...config.value, homePath: environmentHome ?? "" }
            : config.value;
        const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
          Effect.provideService(Path.Path, path),
        );
        homePath = layout.sharedHomePath;
      } else {
        // Grok has no home setting; GROK_HOME or `~/.grok`, as UsageService reads it.
        homePath =
          fromEnvironment.length > 0
            ? path.resolve(expandHomePath(fromEnvironment))
            : path.join(NodeOS.homedir(), ".grok");
      }
      if (isUnder(path, transcript, yield* realPath(homePath))) return instanceId;
    }
    return yield* new ExternalSessionUnsupportedError({ key: target.key, reason: "no-instance" });
  });

  const resolveProject = (target: ContinueTarget) =>
    Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(failed));
      const title = path.basename(target.cwd) || target.cwd;
      const bootstrapped = yield* projects
        .bootstrap({
          commandId: CommandId.make(`external-session-project:${id}`),
          projectId: ProjectId.make(id),
          title,
          workspaceRoot: target.cwd,
        })
        .pipe(
          // A racing create loses with a conflict that names the winner.
          Effect.map(({ project }) => project.id),
          Effect.catchTags({
            ProjectConflictError: (conflict) => Effect.succeed(conflict.conflictingProjectId),
            ProjectOperationError: (error) =>
              error.operation === "normalize-workspace"
                ? Effect.fail(
                    new ExternalSessionUnsupportedError({
                      key: target.key,
                      reason: "folder-missing",
                    }),
                  )
                : Effect.fail(failed(error)),
          }),
          Effect.mapError((error) =>
            error._tag === "ExternalSessionUnsupportedError" ||
            error._tag === "ExternalSessionError"
              ? error
              : failed(error),
          ),
        );
      return bootstrapped;
    });

  /** Reads the transcript; only ever reads it. */
  const readHistory = Effect.fn("ExternalSessions.readHistory")(function* (
    target: ContinueTarget,
    providerInstanceId: ProviderInstanceId,
  ) {
    const unsupported = (reason: ExternalSessionUnsupportedError["reason"]) =>
      new ExternalSessionUnsupportedError({ key: target.key, reason });
    const stats = yield* fileSystem
      .stat(target.transcriptPath)
      .pipe(Effect.mapError(() => unsupported("empty")));
    if (Number(stats.size) > MAX_TRANSCRIPT_BYTES) return yield* unsupported("too-large");
    const contents = yield* fileSystem
      .readFileString(target.transcriptPath)
      .pipe(Effect.mapError(failed));
    const history: ContinueHistory | null =
      target.driver === "claudeAgent" || target.driver === "codex"
        ? parseAgentSessionTranscript({
            source: target.driver,
            providerInstanceId,
            fallbackSessionId: target.sessionId,
            lastActiveAtMs: target.updatedAtMs,
            contents,
          })
        : parsedHistory(target, contents);
    if (history === null) return yield* unsupported("empty");
    return { stats, contents, history };
  });

  const continueSession = Effect.fn("ExternalSessions.continueSession")(function* (
    target: ContinueTarget,
  ) {
    const unsupported = (reason: ExternalSessionUnsupportedError["reason"]) =>
      new ExternalSessionUnsupportedError({ key: target.key, reason });
    const providerInstanceId = yield* resolveInstance(target);
    const { stats, contents, history } = yield* readHistory(target, providerInstanceId);
    // Claude resumes only by a UUID session id.
    if (
      target.driver === "claudeAgent" &&
      !CLAUDE_SESSION_ID_PATTERN.test(history.providerSessionId)
    ) {
      return yield* unsupported("provider");
    }

    const threadId = ThreadId.make(`import:${providerInstanceId}:${history.providerSessionId}`);
    const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
    if (Option.isSome(existing)) {
      if (existing.value.thread.deletedAt !== null) {
        return yield* new ExternalSessionError({
          message: "This session was continued in T3 before, and that thread was deleted.",
        });
      }
      return {
        threadId,
        projectId: existing.value.thread.projectId,
        syncStart: null,
      } satisfies ContinueOutcome;
    }

    const projectId = yield* resolveProject(target);
    const driver = ProviderDriverKind.make(target.driver);
    // Grok and Pi keep the session's own model: their default ids mean
    // "whatever the session uses", while a listed id may not be one T3 knows.
    const model =
      target.driver === "grok" || target.driver === "pi"
        ? (DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL)
        : (history.model ?? target.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL);
    // What the adapter resumes: Pi switches sessions by file path, the others by session id.
    const nativeThreadId =
      target.driver === "pi" ? target.transcriptPath : history.providerSessionId;
    // Each adapter's own id for this native thread, so its first turn updates
    // this provider thread instead of creating a second one. ACP adapters
    // (Grok) scope it by instance; Claude, Codex, and Pi do not.
    const providerThreadId = idAllocator.derive.providerThread({
      driver,
      ...(target.driver === "grok" ? { providerInstanceId } : {}),
      nativeThreadId,
    });
    const claudeHead = target.driver === "claudeAgent" ? claudeLeafUuid(contents) : null;
    const createdAt = DateTime.makeUnsafe(history.createdAt);
    const updatedAt = DateTime.makeUnsafe(history.updatedAt);
    const title = target.title.trim() || history.title.trim() || "Untitled thread";
    const appThread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId,
      title,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: providerThreadId,
      // The provider resumes its own session, which already holds this
      // history. "v1_import" would also hand it over as context on the first
      // turn (Orchestrator prepareLegacyImport), duplicating it. If the
      // resume fails, the fresh-session fallback still carries these runless
      // items in its summary handoff.
      historyOrigin: "native",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt,
      updatedAt,
      archivedAt: null,
      // Active, not settled: the user is about to send the next turn.
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
      driver,
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
      // Claude: resume at the transcript's newest entry (see claudeLeafUuid).
      // The adapter clears it after the first completed turn.
      nativeConversationHeadRef:
        claudeHead === null ? null : { driver, nativeId: claudeHead, strength: "weak" },
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      // ACP adapters scope item ids by instance for threads they create; match that.
      ...(target.driver === "grok"
        ? { contextUsage: null, nativeMetadata: { itemIdentityVersion: 2 as const } }
        : {}),
      createdAt,
      updatedAt,
    };

    // The importer reads only Claude and Codex; for Grok and Pi the provider
    // thread alone marks the session as T3's (ExternalSessions.refreshOwned).
    const importerSource =
      target.driver === "claudeAgent" || target.driver === "codex" ? target.driver : null;
    if (importerSource !== null) {
      yield* runtimes
        .upsert(
          {
            threadId,
            providerName: driver,
            providerInstanceId,
            adapterKey: driver,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            status: "stopped",
            lastSeenAt: history.updatedAt,
            resumeCursor:
              importerSource === "codex"
                ? { threadId: history.providerSessionId }
                : { threadId, resume: history.providerSessionId },
            runtimePayload: { cwd: target.cwd },
          },
          { onConflict: "ignore" },
        )
        .pipe(Effect.mapError(failed));
    }
    yield* eventSink
      .write({
        events: [
          threadCreated(IMPORT_EVENT_PREFIX, threadId, providerInstanceId, appThread),
          ...history.messages.flatMap((message, index) =>
            messageEvents({ prefix: IMPORT_EVENT_PREFIX, threadId, index, message }),
          ),
          providerThreadUpdated(threadId, driver, providerInstanceId, providerThread),
        ],
      })
      .pipe(Effect.mapError(failed));
    // Everything up to the last complete line is in the history above; the
    // sync picks up whatever is appended after it.
    const lastNewline = contents.lastIndexOf("\n");
    const syncStart: ContinueSyncStart = {
      threadId,
      driver: target.driver,
      sessionId: history.providerSessionId,
      transcriptPath: target.transcriptPath,
      offset: lastNewline === -1 ? 0 : Buffer.byteLength(contents.slice(0, lastNewline + 1)),
    };
    if (importerSource === null) {
      return { threadId, projectId, syncStart } satisfies ContinueOutcome;
    }
    // Best-effort, as in the importer: it only lets onboarding skip this file later.
    yield* runtimes
      .recordImportedTranscript({
        threadId,
        source: {
          provider: importerSource,
          providerInstanceId,
          providerSessionId: history.providerSessionId,
          filePath: target.transcriptPath,
          size: Number(stats.size),
          mtimeMs: Option.match(stats.mtime, { onNone: () => null, onSome: (d) => d.getTime() }),
          device: stats.dev,
          inode: Option.getOrNull(stats.ino),
          birthtimeMs: Option.match(stats.birthtime, {
            onNone: () => null,
            onSome: (d) => d.getTime(),
          }),
        },
      })
      .pipe(Effect.ignore);
    return { threadId, projectId, syncStart } satisfies ContinueOutcome;
  });

  /**
   * A new thread on another agent that starts from this session's history.
   * Runs whether or not the session is still running, since it only reads.
   */
  const handoffSession = Effect.fn("ExternalSessions.handoffSession")(function* (
    target: ContinueTarget,
    to: HandoffTo,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(failed));
    const instances = deriveProviderInstanceConfigMap(settings);
    const instance: ProviderInstanceConfig | undefined = Object.hasOwn(instances, to.instanceId)
      ? instances[to.instanceId]
      : undefined;
    if (instance === undefined || !resolveProviderInstanceEnabled(instance)) {
      return yield* new ExternalSessionUnsupportedError({ key: target.key, reason: "no-instance" });
    }
    if (instance.driver === target.driver) {
      return yield* new ExternalSessionError({
        message: "Pick a different agent, or continue this session in place.",
      });
    }
    const { history } = yield* readHistory(target, to.instanceId);
    const projectId = yield* resolveProject(target);
    const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(failed));
    const threadId = ThreadId.make(`${HANDOFF_THREAD_PREFIX}:${id}`);
    const now = yield* DateTime.now;
    const title = target.title.trim() || history.title.trim() || "Untitled thread";
    const appThread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId,
      title,
      providerInstanceId: to.instanceId,
      modelSelection: { instanceId: to.instanceId, model: to.model },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      linkedPullRequest: null,
      branchPullRequest: null,
      // The first turn creates a fresh provider thread with no native
      // session, which is what makes it carry the history as context.
      activeProviderThreadId: null,
      historyOrigin: "v1_import",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: DateTime.makeUnsafe(history.createdAt),
      updatedAt: now,
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
    yield* eventSink
      .write({
        events: [
          threadCreated(HANDOFF_EVENT_PREFIX, threadId, to.instanceId, appThread),
          ...history.messages.flatMap((message, index) =>
            messageEvents({ prefix: HANDOFF_EVENT_PREFIX, threadId, index, message }),
          ),
        ],
      })
      .pipe(Effect.mapError(failed));
    return { threadId, projectId } satisfies ExternalSessionContinueResult;
  });

  return { continueSession, handoffSession };
});
