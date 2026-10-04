/**
 * Continue an external session in T3: a single-session version of
 * `AgentSessionImporter.importRecentAgentThreads`. It writes the same records
 * the importer writes (thread, messages, provider thread, provider runtime,
 * imported transcript), so the thread resumes the provider's own session on
 * its next turn, exactly like an imported one. Unlike the importer, the
 * thread starts active rather than settled, because the user just asked to
 * keep working in it. Fork add-on; see docs/internals/external-sessions.md.
 *
 * @module external-sessions/continueExternalSession
 */
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
import * as ServerSettings from "../serverSettings.ts";

// Same prefix and id shapes as AgentSessionImporter, so a session continued
// here and one imported during onboarding are the same thread.
const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// The parser holds the whole transcript in memory; past this it is not worth it.
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

export interface ContinueTarget {
  readonly key: string;
  readonly driver: "claudeAgent" | "codex";
  readonly sessionId: string;
  readonly title: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly transcriptPath: string;
  readonly updatedAtMs: number;
}

const failed = (cause: unknown) =>
  new ExternalSessionError({ message: "Could not continue this session in T3.", cause });

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = DateTime.makeUnsafe(input.message.createdAt);
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
    ordinal: input.index + 1,
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
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
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
   * The provider instance whose home holds this transcript, chosen the way
   * AgentSessionScanner chooses the owner of a shared home: enabled
   * instances of the driver, the built-in one first.
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

    const transcript = yield* realPath(target.transcriptPath);
    for (const { instanceId, config: instance } of instances) {
      const homeVariable = source === "claudeAgent" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      const environmentHome =
        instance.environment?.findLast((variable) => variable.name === homeVariable)?.value ??
        hostEnvironment[homeVariable];
      let homePath: string;
      if (source === "claudeAgent") {
        const config = decodeClaudeSettings(instance.config ?? {});
        if (Option.isNone(config)) continue;
        const configured = config.value.homePath.trim();
        const fromEnvironment = environmentHome?.trim() ?? "";
        homePath =
          configured.length > 0
            ? path.resolve(expandHomePath(configured))
            : fromEnvironment.length > 0
              ? path.resolve(expandHomePath(fromEnvironment))
              : path.join(NodeOS.homedir(), ".claude");
      } else {
        const config = decodeCodexSettings(instance.config ?? {});
        if (Option.isNone(config)) continue;
        const codexSettings =
          config.value.homePath.trim().length === 0 &&
          config.value.shadowHomePath.trim().length === 0 &&
          environmentHome?.trim()
            ? { ...config.value, homePath: environmentHome }
            : config.value;
        const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
          Effect.provideService(Path.Path, path),
        );
        homePath = layout.sharedHomePath;
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

  const continueSession = Effect.fn("ExternalSessions.continueSession")(function* (
    target: ContinueTarget,
  ) {
    const unsupported = (reason: ExternalSessionUnsupportedError["reason"]) =>
      new ExternalSessionUnsupportedError({ key: target.key, reason });
    const providerInstanceId = yield* resolveInstance(target);

    const stats = yield* fileSystem
      .stat(target.transcriptPath)
      .pipe(Effect.mapError(() => unsupported("empty")));
    if (Number(stats.size) > MAX_TRANSCRIPT_BYTES) return yield* unsupported("too-large");
    const contents = yield* fileSystem
      .readFileString(target.transcriptPath)
      .pipe(Effect.mapError(failed));
    const thread = parseAgentSessionTranscript({
      source: target.driver,
      providerInstanceId,
      fallbackSessionId: target.sessionId,
      lastActiveAtMs: target.updatedAtMs,
      contents,
    });
    if (thread === null) return yield* unsupported("empty");
    // Claude resumes only by a UUID session id.
    if (
      thread.source === "claudeAgent" &&
      !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
    ) {
      return yield* unsupported("provider");
    }

    const threadId = ThreadId.make(`import:${providerInstanceId}:${thread.providerSessionId}`);
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
      } satisfies ExternalSessionContinueResult;
    }

    const projectId = yield* resolveProject(target);
    const driver = ProviderDriverKind.make(thread.source);
    const model =
      thread.model ?? target.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
    const providerThreadId = idAllocator.derive.providerThread({
      driver,
      nativeThreadId: thread.providerSessionId,
    });
    const createdAt = DateTime.makeUnsafe(thread.createdAt);
    const updatedAt = DateTime.makeUnsafe(thread.updatedAt);
    const title = target.title.trim() || thread.title.trim() || "Untitled thread";
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
      // Imported history hands off to the provider as context, as for onboarding imports.
      historyOrigin: "v1_import",
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
      nativeThreadRef: { driver, nativeId: thread.providerSessionId, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt,
      updatedAt,
    };

    yield* runtimes
      .upsert(
        {
          threadId,
          providerName: driver,
          providerInstanceId,
          adapterKey: driver,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          status: "stopped",
          lastSeenAt: thread.updatedAt,
          resumeCursor:
            thread.source === "codex"
              ? { threadId: thread.providerSessionId }
              : { threadId, resume: thread.providerSessionId },
          runtimePayload: { cwd: target.cwd },
        },
        { onConflict: "ignore" },
      )
      .pipe(Effect.mapError(failed));
    yield* eventSink
      .write({
        events: [
          {
            id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt: createdAt,
            payload: appThread,
          },
          ...thread.messages.flatMap((message, index) =>
            messageEvents({ threadId, index, message }),
          ),
          {
            id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
            type: "provider-thread.updated",
            threadId,
            driver,
            providerInstanceId,
            occurredAt: updatedAt,
            payload: providerThread,
          },
        ],
      })
      .pipe(Effect.mapError(failed));
    // Best-effort, as in the importer: it only lets onboarding skip this file later.
    yield* runtimes
      .recordImportedTranscript({
        threadId,
        source: {
          provider: thread.source,
          providerInstanceId,
          providerSessionId: thread.providerSessionId,
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
    return { threadId, projectId } satisfies ExternalSessionContinueResult;
  });

  return continueSession;
});
