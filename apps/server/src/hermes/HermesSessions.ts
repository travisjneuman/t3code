/**
 * The Hermes Agent section's server side. `list` merges the sessions a Hermes
 * server holds with the T3 threads already bound to them; `continue` opens a
 * session as a thread in the Scratch project, its messages, reasoning, tool
 * calls and any cron report imported and its next turn resuming the same
 * Hermes session, and syncs what Hermes added since; `update` pins, unpins or
 * archives, `delete` deletes the session in Hermes and its T3 thread. The
 * dashboard proxy serves Settings › Providers › Hermes Agent and never
 * returns a secret's value; `t3Tools` gives Hermes's API server T3's thread
 * tools, or takes them away; `insights` reads any session's details card
 * without opening it. Fork add-on; see docs/user/hermes.md.
 *
 * @module hermes/HermesSessions
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  HERMES_DEFAULT_MODEL,
  HERMES_SESSIONS_PAGE,
  HERMES_SESSIONS_WINDOW_MS,
  type HermesDashboardInput,
  type HermesDashboardResult,
  type HermesSessionSummary,
  type HermesSessionsBatchResult,
  type HermesSessionsContinueInput,
  type HermesSessionsContinueResult,
  type HermesSessionsDeleteInput,
  type HermesSessionsEmptyResult,
  HermesSessionsError,
  type HermesSessionsInsightsInput,
  type HermesSessionsListArchivedResult,
  type HermesSessionsListInput,
  type HermesSessionsListResult,
  type HermesSessionsProvidersResult,
  type HermesSessionsUnarchiveInput,
  type HermesSessionsUpdateInput,
  type HermesT3ToolsInput,
  type HermesT3ToolsResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type SessionInsights,
  ThreadId,
} from "@t3tools/contracts";
import {
  HermesApi,
  HermesInsights,
  decodeHermesProviders,
  isOfferableHermesProvider,
} from "@t3tools/provider-hermes/server";
import { HermesSettings } from "@t3tools/provider-hermes/settings";
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
import * as HermesSessionArchive from "./hermesSessionArchive.ts";
import {
  type HermesSessionEntry,
  cronDeliveryNotice,
  cronOutputStamp,
  cronReportText,
  cronSessionOf,
  entryEvents,
  entryItemId,
  sessionEntries,
  stampDeltaMs,
  toMs,
} from "./hermesSessionEntries.ts";

export class HermesSessions extends Context.Service<
  HermesSessions,
  {
    readonly list: (
      input: HermesSessionsListInput,
    ) => Effect.Effect<HermesSessionsListResult, HermesSessionsError>;
    readonly providers: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<HermesSessionsProvidersResult, HermesSessionsError>;
    readonly continueSession: (
      input: HermesSessionsContinueInput,
    ) => Effect.Effect<HermesSessionsContinueResult, HermesSessionsError>;
    readonly update: (
      input: HermesSessionsUpdateInput,
    ) => Effect.Effect<HermesSessionsBatchResult, HermesSessionsError>;
    readonly deleteSessions: (
      input: HermesSessionsDeleteInput,
    ) => Effect.Effect<HermesSessionsBatchResult, HermesSessionsError>;
    readonly listArchived: Effect.Effect<HermesSessionsListArchivedResult, HermesSessionsError>;
    readonly unarchive: (
      input: HermesSessionsUnarchiveInput,
    ) => Effect.Effect<HermesSessionsEmptyResult, HermesSessionsError>;
    readonly dashboard: (
      input: HermesDashboardInput,
    ) => Effect.Effect<HermesDashboardResult, HermesSessionsError>;
    readonly t3Tools: (
      input: HermesT3ToolsInput,
    ) => Effect.Effect<HermesT3ToolsResult, HermesSessionsError>;
    readonly insights: (
      input: HermesSessionsInsightsInput,
    ) => Effect.Effect<SessionInsights, HermesSessionsError>;
  }
>()("t3/hermes/HermesSessions") {}

const HERMES_DRIVER = ProviderDriverKind.make("hermes");
const IMPORT_EVENT_PREFIX = "hermes-session-import:v2";
/** Threads opened before tool calls were imported: text only, under `import:` ids. */
const LEGACY_IMPORT_PREFIX = "hermes-session-import:v1";
const LIST_PAGE_SIZE = 200;
// Enough for a long "Load more" history without walking an unbounded store.
const MAX_LIST_PAGES = 25;
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
// A T3 turn's own messages land in the Hermes session too; anything Hermes
// stored inside a T3 run's window is that run's, already on screen. Hermes
// usually runs on another machine, so the margins allow for clock skew.
const WINDOW_LEAD_MS = 30_000;
const WINDOW_TRAIL_MS = 30_000;
// Enough cron history to find the run after this one.
const CRON_RUNS_LOOKUP = 50;
/** Hermes pages a long session's messages, so the details read gets longer than one request. */
const INSIGHTS_TIMEOUT = "30 seconds";
const NO_ENTRIES: ReadonlyArray<HermesSessionEntry> = [];
const REDACTED = "••••••";
const SECRET_KEY = /(?:api_?key|secret|token|password)$/i;
/** Hermes's own partial reveals (`api_key_preview`, `redacted_value`), dropped outright. */
const SECRET_PREVIEW_KEY = /(?:_preview|^redacted_value)$/i;
const ENV_FIELDS = [
  "is_set",
  "description",
  "category",
  "is_password",
  "provider_label",
  "advanced",
  "channel_managed",
  "custom",
] as const;

// T3 tools: Hermes's MCP servers are global, so while the switch is on every
// platform but the API server is pinned to no MCP servers.
const T3_TOOLS_SERVER = "t3-code";
const T3_TOOLS_ENV_KEY = "MCP_T3_CODE_API_KEY";
/** What a Hermes run needs to start, watch and steer T3 coworkers. */
const T3_TOOLS = [
  "t3_project_list",
  "t3_project_read",
  "t3_thread_launch",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_wait",
  "t3_thread_send",
  "t3_thread_interrupt",
  "orchestrator_capabilities",
];
/** Hermes's platforms other than the API server, with the toolset each gets by default. */
const NON_API_PLATFORMS: Readonly<Record<string, string>> = {
  cli: "hermes-cli",
  telegram: "hermes-telegram",
  discord: "hermes-discord",
  slack: "hermes-slack",
  whatsapp: "hermes-whatsapp",
  whatsapp_cloud: "hermes-whatsapp",
  signal: "hermes-signal",
  bluebubbles: "hermes-bluebubbles",
  email: "hermes-email",
  homeassistant: "hermes-homeassistant",
  mattermost: "hermes-mattermost",
  matrix: "hermes-matrix",
  dingtalk: "hermes-dingtalk",
  feishu: "hermes-feishu",
  wecom: "hermes-wecom",
  wecom_callback: "hermes-wecom-callback",
  weixin: "hermes-weixin",
  qqbot: "hermes-qqbot",
  yuanbao: "hermes-yuanbao",
  webhook: "hermes-webhook",
  cron: "hermes-cron",
};
/** Toolsets Hermes adds once Discord's list is explicit; disabled to keep its default. */
const DISCORD_EXPLICIT_TOOLSETS = ["discord", "discord_admin"];

const decodeHermesSettings = Schema.decodeUnknownOption(HermesSettings);

const failed = (message: string) => (cause: unknown) => new HermesSessionsError({ message, cause });
const fromApi = (error: HermesApi.HermesApiError) =>
  new HermesSessionsError({ message: error.detail });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hostOfUrl = (url: string): string | undefined => {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
};

const httpUrlOf = (text: string | undefined): string | undefined => {
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

/** A platform's toolset list as Hermes reads it, or undefined for its default. */
const toolsetListOf = (value: unknown): ReadonlyArray<string> | undefined => {
  if (Array.isArray(value)) return value.filter((name) => typeof name === "string");
  if (typeof value === "string" && value.trim() !== "") {
    return value
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "");
  }
  return undefined;
};

/** What turning T3 tools on changed in Hermes's config, to put back when it is turned off. */
interface T3ToolsRestore {
  /** Each pinned platform's original list; null where it had none. */
  readonly platforms: Record<string, unknown>;
  /** `agent.disabled_toolsets` before T3 changed it; absent when T3 left it alone. */
  readonly disabledToolsets?: unknown;
}

const parseT3ToolsRestore = (text: string): T3ToolsRestore | undefined => {
  if (text === "") return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) && isRecord(value.platforms)
      ? {
          platforms: value.platforms,
          ...("disabledToolsets" in value ? { disabledToolsets: value.disabledToolsets } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
};

/** Replaces each non-empty secret-named string with a placeholder, at any depth. */
const redactSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      SECRET_PREVIEW_KEY.test(key)
        ? []
        : [
            [
              key,
              SECRET_KEY.test(key) && typeof child === "string" && child.length > 0
                ? REDACTED
                : redactSecrets(child),
            ],
          ],
    ),
  );
};

/** Puts the stored value back wherever a save sends the placeholder unchanged. */
const restoreSecrets = (incoming: unknown, current: unknown): unknown => {
  if (incoming === REDACTED) return current;
  if (Array.isArray(incoming)) {
    return incoming.map((child, index) =>
      restoreSecrets(child, Array.isArray(current) ? current[index] : undefined),
    );
  }
  if (!isRecord(incoming)) return incoming;
  const base = isRecord(current) ? current : {};
  return Object.fromEntries(
    Object.entries(incoming).map(([key, child]) => [key, restoreSecrets(child, base[key])]),
  );
};

/**
 * `/api/env` minus anything that could carry a value: whether each key is set,
 * and its labels. Hermes marks a set key by a non-empty `redacted_value`.
 */
const envStatusOnly = (body: unknown): unknown =>
  isRecord(body)
    ? Object.fromEntries(
        Object.entries(body).map(([name, entry]) => [
          name,
          isRecord(entry)
            ? {
                ...Object.fromEntries(
                  ENV_FIELDS.flatMap((field) => (field in entry ? [[field, entry[field]]] : [])),
                ),
                is_set:
                  entry.is_set === true ||
                  (typeof entry.redacted_value === "string" && entry.redacted_value.length > 0),
              }
            : { is_set: false },
        ]),
      )
    : {};

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
  const archive = yield* HermesSessionArchive.make;

  const commandId = (kind: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((id) => CommandId.make(`hermes-session-${kind}:${id}`)),
      Effect.mapError(failed("Could not update the thread.")),
    );

  /** The instance's settings, secrets included; only for a Hermes instance. */
  const settingsOf = Effect.fn("HermesSessions.settingsOf")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(failed("Could not read settings.")),
    );
    const instance = settings.providerInstances[instanceId];
    if (instance === undefined || instance.driver !== HERMES_DRIVER) {
      return yield* new HermesSessionsError({ message: "That is not a Hermes Agent provider." });
    }
    return yield* Option.match(decodeHermesSettings(instance.config ?? {}), {
      onNone: () =>
        Effect.fail(new HermesSessionsError({ message: "The Hermes Agent settings are invalid." })),
      onSome: Effect.succeed,
    });
  });

  const connectionOf = (instanceId: ProviderInstanceId) =>
    settingsOf(instanceId).pipe(Effect.map(HermesApi.connectionOf));

  /** The live T3 thread bound to each Hermes session of this instance, by session id. */
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
        AND json_extract(p.payload_json, '$.driver') = ${HERMES_DRIVER}
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
      Effect.mapError(failed("Could not read T3's Hermes threads.")),
    );

  /**
   * Hermes's own subagents (`delegate_task` runs), each with the listed row it
   * belongs under. A subagent's parent is usually a middle compression segment
   * of a long conversation, and Hermes lists that conversation under its newest
   * segment, so the walk climbs `parent_session_id` until it meets a listed id
   * or a listed row's chain root. One with no listed ancestor is dropped.
   * It is a second walk because `include_children` also turns off that
   * newest-segment projection, and bound threads key on the projected ids.
   *
   * The child listing is ordered like the top-level one, a compression segment
   * at its chain's newest activity, so it stops at the first row older than
   * `floor` that is not a segment: every row after it is older too.
   */
  const subagentsUnder = Effect.fn("HermesSessions.subagentsUnder")(function* (
    connection: HermesApi.HermesConnection,
    listedIdOf: ReadonlyMap<string, string>,
    floor: number,
  ) {
    if (listedIdOf.size === 0) return [];
    const parentOf = new Map<string, string | null>();
    const subagents: HermesApi.HermesSession[] = [];
    pages: for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = yield* HermesApi.listSessions(connection, {
        limit: LIST_PAGE_SIZE,
        offset: page * LIST_PAGE_SIZE,
        includeChildren: true,
      });
      for (const session of result.sessions) {
        if (parentOf.has(session.id)) continue;
        // Pins are back-filled past the page whatever their age.
        if (
          !session.pinned &&
          session.endReason !== "compression" &&
          toMs(session.lastActive) < floor
        ) {
          break pages;
        }
        parentOf.set(session.id, session.parentSessionId);
        if (session.source === "subagent" && !listedIdOf.has(session.id)) subagents.push(session);
      }
      if (!result.hasMore) break;
    }
    return subagents.flatMap((session) => {
      const seen = new Set<string>();
      let current = session.parentSessionId;
      while (current !== null && !seen.has(current)) {
        const listedId = listedIdOf.get(current);
        if (listedId !== undefined) return [{ session, parentSessionId: listedId }];
        seen.add(current);
        current = parentOf.get(current) ?? null;
      }
      return [];
    });
  });

  const list: HermesSessions["Service"]["list"] = Effect.fn("HermesSessions.list")(
    function* (input) {
      const connection = yield* connectionOf(input.instanceId);
      const bound = yield* boundThreads(input.instanceId);
      const cutoff = Date.now() - HERMES_SESSIONS_WINDOW_MS;
      const olderAllowed = input.extra * HERMES_SESSIONS_PAGE;
      const summaryOf = (session: HermesApi.HermesSession): HermesSessionSummary => {
        const thread = bound.get(session.id);
        return {
          id: session.id,
          title: session.title ?? session.preview ?? "Untitled session",
          source: session.source,
          model: session.model,
          lastActiveAt: toMs(session.lastActive),
          messageCount: session.messageCount,
          pinned: session.pinned,
          // An archived thread is taken up again by continue, as a fresh pick.
          threadId: thread === undefined || thread.archived ? null : thread.threadId,
        };
      };
      const byId = new Map<string, HermesSessionSummary>();
      // Each listed row's id, by itself and by its compression chain's root.
      const listedIdOf = new Map<string, string>();
      let older = 0;
      let hasMore = false;
      let oldestListed = cutoff;
      // Hermes lists by last activity, newest first, with every pin back-filled
      // onto each page; the window and "Load more" decide where to stop.
      pages: for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = yield* HermesApi.listSessions(connection, {
          limit: LIST_PAGE_SIZE,
          offset: page * LIST_PAGE_SIZE,
        }).pipe(Effect.mapError(fromApi));
        for (const session of result.sessions) {
          if (byId.has(session.id)) continue;
          const summary = summaryOf(session);
          if (!session.pinned && summary.lastActiveAt < cutoff) {
            if (older >= olderAllowed) {
              hasMore = true;
              break pages;
            }
            older++;
            oldestListed = Math.min(oldestListed, summary.lastActiveAt);
          }
          byId.set(session.id, summary);
          listedIdOf.set(session.id, session.id);
          if (session.lineageRootId !== null) listedIdOf.set(session.lineageRootId, session.id);
        }
        if (!result.hasMore) break;
        if (page === MAX_LIST_PAGES - 1) hasMore = true;
      }
      // Subagents reach back as far as the listed rows do. Failing to read them
      // costs only the nesting, never the list.
      const subagents = yield* subagentsUnder(
        connection,
        listedIdOf,
        hasMore ? oldestListed : 0,
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Hermes subagents unavailable", error).pipe(Effect.as([])),
        ),
      );
      const sessions = [
        ...byId.values(),
        ...subagents.map(({ session, parentSessionId }) => ({
          ...summaryOf(session),
          parentSessionId,
        })),
      ].sort(
        (left, right) =>
          Number(right.pinned) - Number(left.pinned) || right.lastActiveAt - left.lastActiveAt,
      );
      return { sessions, hasMore };
    },
  );

  const providers: HermesSessions["Service"]["providers"] = Effect.fn("HermesSessions.providers")(
    function* (instanceId) {
      const connection = yield* connectionOf(instanceId);
      const body = yield* HermesApi.modelOptions(connection).pipe(Effect.mapError(fromApi));
      return {
        providers: decodeHermesProviders(body).map((provider) => ({
          slug: provider.slug,
          name: provider.name,
          authenticated: provider.authenticated,
          offerable: isOfferableHermesProvider(provider),
          modelCount: provider.models.length,
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

  /**
   * A cron run's delivered report, as Hermes saved it beside the job: the
   * earliest output doc from this run, before the job's next run. Best effort;
   * a session that is not a cron run, or a dashboard T3 cannot read, has none.
   */
  const cronReportOf = (settings: HermesSettings, session: HermesApi.HermesSession) =>
    Effect.gen(function* () {
      const cron = session.source === "cron" ? cronSessionOf(session.id) : undefined;
      if (cron === undefined || !settings.dashboardUrl) return NO_ENTRIES;
      const dashboard = HermesApi.dashboardConnectionOf(settings);
      const job = yield* HermesApi.getCronJob(dashboard, cron.jobId);
      if (job === undefined || job.hermesHome === null) return NO_ENTRIES;
      const separator = job.hermesHome.includes("\\") ? "\\" : "/";
      const folder = [job.hermesHome.replace(/[\\/]+$/, ""), "cron", "output", cron.jobId].join(
        separator,
      );
      const next = (yield* HermesApi.listCronRunSessionIds(dashboard, cron.jobId, CRON_RUNS_LOOKUP))
        .map((id) => cronSessionOf(id)?.stamp)
        .filter((stamp): stamp is string => stamp !== undefined && stamp > cron.stamp)
        .sort()[0];
      const doc = (yield* HermesApi.listHostDirectory(dashboard, folder))
        .map((name) => ({ name, stamp: cronOutputStamp(name) }))
        .filter(
          (file): file is { name: string; stamp: string } =>
            file.stamp !== undefined &&
            file.stamp >= cron.stamp &&
            (next === undefined || file.stamp < next),
        )
        .sort((left, right) => left.stamp.localeCompare(right.stamp))[0];
      if (doc === undefined) return NO_ENTRIES;
      const text = yield* HermesApi.readHostTextFile(dashboard, `${folder}${separator}${doc.name}`);
      const report = text === undefined ? "" : cronReportText(text);
      if (!report) return NO_ENTRIES;
      const atMs = toMs(session.startedAt) + stampDeltaMs(cron.stamp, doc.stamp);
      const stem = doc.name.replace(/\.md$/, "");
      const entries: ReadonlyArray<HermesSessionEntry> = [
        {
          kind: "notice",
          key: `cron-delivery:${stem}`,
          atMs,
          text: cronDeliveryNotice(job.deliver),
        },
        { kind: "message", key: `cron-report:${stem}`, atMs, role: "assistant", text: report },
      ];
      return entries;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Hermes cron report unavailable", error).pipe(Effect.as(NO_ENTRIES)),
      ),
    );

  /** Everything the session holds, oldest first. */
  const entriesOf = Effect.fn("HermesSessions.entriesOf")(function* (
    instanceId: ProviderInstanceId,
    sessionId: string,
  ) {
    const settings = yield* settingsOf(instanceId);
    const connection = HermesApi.connectionOf(settings);
    // Hermes may be on another machine, so the session (then its cron report)
    // and its messages are fetched side by side rather than one after another.
    const [{ session, report }, messages] = yield* Effect.all(
      [
        HermesApi.getSession(connection, sessionId).pipe(
          Effect.mapError(fromApi),
          Effect.flatMap((session) =>
            session === undefined
              ? Effect.fail(new HermesSessionsError({ message: "Hermes has no such session." }))
              : cronReportOf(settings, session).pipe(Effect.map((report) => ({ session, report }))),
          ),
        ),
        HermesApi.listMessages(connection, sessionId).pipe(Effect.mapError(fromApi)),
      ],
      { concurrency: "unbounded" },
    );
    const entries = sessionEntries(messages, {
      ended: session.endedAt !== null,
      fallbackMs: toMs(session.startedAt),
    });
    const lastText = entries.findLast(
      (entry) => entry.kind === "message" && entry.role === "assistant",
    );
    // The report is the run's final answer; skip it when the session already ends on it.
    const reportEntries = report.filter(
      (entry) =>
        entry.kind !== "message" ||
        lastText?.kind !== "message" ||
        lastText.text.trim() !== entry.text.trim(),
    );
    return { session, entries: [...entries, ...reportEntries] };
  });

  /** One write for a batch of new entries, each placed after the T3 run before it. */
  const appendEntries = Effect.fn("HermesSessions.appendEntries")(function* (
    threadId: ThreadId,
    entries: ReadonlyArray<HermesSessionEntry>,
    runs: ReadonlyArray<{ readonly ordinal: number; readonly startedAtMs: number }>,
  ) {
    if (entries.length === 0) return;
    const batch = yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError(failed("Could not sync this session.")));
    const now = yield* DateTime.now;
    const events: OrchestrationV2DomainEvent[] = [];
    for (const entry of entries) {
      let band: number | undefined;
      for (const run of runs) {
        if (run.startedAtMs <= entry.atMs && (band === undefined || run.ordinal > band)) {
          band = run.ordinal;
        }
      }
      // Placed now, in the run's band; the sink's own allocation keeps it.
      const ordinal = yield* positions
        .allocate({
          threadId,
          turnItemId: entryItemId(IMPORT_EVENT_PREFIX, threadId, entry.key),
          runId: null,
          ...(band === undefined ? {} : { runOrdinal: band }),
        })
        .pipe(Effect.mapError(failed("Could not sync this session.")));
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
      .pipe(Effect.mapError(failed("Could not sync this session.")));
  });

  /** A new thread holding the whole session, bound to it. */
  const createThread = Effect.fn("HermesSessions.createThread")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly session: HermesApi.HermesSession;
    readonly entries: ReadonlyArray<HermesSessionEntry>;
    /** The thread this one replaces, whose title, pin and other state it keeps. */
    readonly replacing?: OrchestrationV2AppThread;
  }) {
    const { instanceId, threadId, session, entries, replacing } = input;
    const projectId =
      replacing?.projectId ??
      (yield* managedFolders.ensureScratchProject.pipe(
        Effect.mapError(failed("The Scratch project is unavailable.")),
      )).projectId;
    const now = yield* DateTime.now;
    const startedAt =
      session.startedAt === null ? now : DateTime.makeUnsafe(toMs(session.startedAt));
    const updatedAt =
      session.lastActive === null ? now : DateTime.makeUnsafe(toMs(session.lastActive));
    const providerThreadId = idAllocator.derive.providerThread({
      driver: HERMES_DRIVER,
      providerInstanceId: instanceId,
      nativeThreadId: session.id,
    });
    const appThread: OrchestrationV2AppThread =
      replacing === undefined
        ? {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId,
            title: session.title ?? session.preview ?? "Hermes session",
            providerInstanceId: instanceId,
            // Every turn sends the picked model; "Hermes default" until one is picked.
            modelSelection: { instanceId, model: HERMES_DEFAULT_MODEL },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: providerThreadId,
            // Hermes resumes its own session, which already holds this history.
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
          }
        : {
            ...replacing,
            id: threadId,
            activeProviderThreadId: providerThreadId,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            archivedAt: null,
            deletedAt: null,
            updatedAt: now,
          };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver: HERMES_DRIVER,
      providerInstanceId: instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver: HERMES_DRIVER, nativeId: session.id, strength: "strong" },
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
        // Moves the binding here when it replaces an older thread.
        id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}:${threadId}`),
        type: "provider-thread.updated",
        threadId,
        driver: HERMES_DRIVER,
        providerInstanceId: instanceId,
        occurredAt: updatedAt,
        payload: providerThread,
      },
    ];
    yield* eventSink
      .write({ events })
      .pipe(Effect.mapError(failed("Could not open this session in T3.")));
    return { threadId, projectId };
  });

  /**
   * Removes the text-only copy a replacement left behind when its delete
   * failed. The replacement took over its provider thread, so only its
   * `import:` id still names it. A copy continued in T3 stays.
   */
  const dropLegacyCopy = (instanceId: ProviderInstanceId, sessionId: string) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(`import:${instanceId}:${sessionId}`);
      const records = yield* Effect.option(
        orchestrator.getThreadRecords(threadId, ["runs", "turnItems"]),
      );
      if (Option.isNone(records)) return;
      const { thread, runs, turnItems } = records.value;
      if (thread.deletedAt !== null || runs.length > 0) return;
      if (!turnItems.some((item) => item.id.startsWith(LEGACY_IMPORT_PREFIX))) return;
      yield* orchestrator
        .dispatch({ type: "thread.delete", commandId: yield* commandId("replace"), threadId })
        .pipe(
          Effect.mapError(failed("Opened the full session, but the old thread is still there.")),
        );
    });

  const openSession: HermesSessions["Service"]["continueSession"] = Effect.fn(
    "HermesSessions.continueSession",
  )(function* (input) {
    const { instanceId, sessionId } = input;
    const bound = (yield* boundThreads(instanceId)).get(sessionId);
    const freshId = ThreadId.make(`hermes:${instanceId}:${sessionId}`);
    const threadId = bound?.threadId ?? freshId;
    const existing = yield* Effect.option(
      orchestrator.getThreadRecords(threadId, ["runs", "turnItems"]),
    );
    if (Option.isNone(existing)) {
      const { session, entries } = yield* entriesOf(instanceId, sessionId);
      return yield* createThread({ instanceId, threadId, session, entries });
    }
    const records = existing.value;
    if (records.thread.deletedAt !== null) {
      return yield* new HermesSessionsError({
        message: "This session was opened in T3 before, and that thread was deleted.",
      });
    }
    yield* unarchiveThread(threadId);
    if (threadId === freshId) yield* dropLegacyCopy(instanceId, sessionId);
    const opened = { threadId, projectId: records.thread.projectId };
    // A turn in flight writes its own items; the next open syncs the rest.
    if (records.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) return opened;

    const { session, entries } = yield* entriesOf(instanceId, sessionId);
    const legacy = records.turnItems.filter((item) => item.id.startsWith(LEGACY_IMPORT_PREFIX));
    if (legacy.length > 0 && records.runs.length === 0 && threadId !== freshId) {
      // Opened before tool calls were imported, and never continued here:
      // replace it with the whole session, keeping its title, pin and state.
      const replaced = yield* createThread({
        instanceId,
        threadId: freshId,
        session,
        entries,
        replacing: { ...records.thread, archivedAt: null },
      });
      yield* orchestrator
        .dispatch({ type: "thread.delete", commandId: yield* commandId("replace"), threadId })
        .pipe(
          Effect.mapError(failed("Opened the full session, but the old thread is still there.")),
        );
      return replaced;
    }

    const written = new Set(records.turnItems.map((item) => item.id));
    const shownText = new Set(
      records.turnItems.flatMap((item) =>
        item.type === "user_message" || item.type === "assistant_message" ? [item.text.trim()] : [],
      ),
    );
    // An older thread already shows the text up to its import; only add after it.
    const importedUntil = Math.max(
      0,
      ...legacy.map((item) => DateTime.toEpochMillis(item.completedAt ?? item.updatedAt)),
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
        entry.atMs > importedUntil &&
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
  });

  // Opening takes a few seconds when Hermes is on another machine. Another open
  // of the same session meanwhile, from a repeat click or another client,
  // shares the one in flight: run alongside, it would write the same import
  // events again and fail. Nothing is kept once the open settles.
  const opening = yield* Cache.makeWith(
    (key: string) => {
      const [instanceId = "", sessionId = ""] = key.split("\u0000");
      return openSession({ instanceId: ProviderInstanceId.make(instanceId), sessionId });
    },
    { capacity: 256, timeToLive: () => Duration.zero },
  );
  const continueSession: HermesSessions["Service"]["continueSession"] = (input) =>
    Cache.get(opening, `${input.instanceId}\u0000${input.sessionId}`);

  /** Runs `each` per session; a failure refuses that session and the rest go on. */
  const batch = <A>(
    items: ReadonlyArray<A>,
    idOf: (item: A) => string,
    each: (item: A) => Effect.Effect<void, HermesSessionsError>,
  ) =>
    Effect.forEach(items, (item) =>
      each(item).pipe(
        Effect.as({ id: idOf(item), message: null as string | null }),
        Effect.catch((error) => Effect.succeed({ id: idOf(item), message: error.message })),
      ),
    ).pipe(
      Effect.map((outcomes) => ({
        done: outcomes.flatMap((outcome) => (outcome.message === null ? [outcome.id] : [])),
        refused: outcomes.flatMap((outcome) =>
          outcome.message === null ? [] : [{ id: outcome.id, message: outcome.message }],
        ),
      })),
    );

  const update: HermesSessions["Service"]["update"] = Effect.fn("HermesSessions.update")(
    function* (input) {
      const connection = yield* connectionOf(input.instanceId);
      const bound = yield* boundThreads(input.instanceId);
      return yield* batch(
        input.sessions,
        (session) => session.id,
        (session) =>
          Effect.gen(function* () {
            yield* HermesApi.patchSession(connection, session.id, {
              ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
              ...(input.archived ? { archived: true } : {}),
            }).pipe(Effect.mapError(fromApi));
            if (!input.archived) return;
            const thread = bound.get(session.id);
            yield* archive.put({
              instanceId: input.instanceId,
              id: session.id,
              title: session.title || "Untitled session",
              threadId: thread?.threadId ?? null,
              archivedAt: new Date().toISOString(),
            });
            if (thread !== undefined && !thread.archived) {
              yield* orchestrator
                .dispatch({
                  type: "thread.archive",
                  commandId: yield* commandId("archive"),
                  threadId: thread.threadId,
                })
                .pipe(Effect.mapError(failed("Archived in Hermes, but not the T3 thread.")));
            }
          }),
      );
    },
  );

  const deleteSessions: HermesSessions["Service"]["deleteSessions"] = Effect.fn(
    "HermesSessions.deleteSessions",
  )(function* (input) {
    const connection = yield* connectionOf(input.instanceId);
    const bound = yield* boundThreads(input.instanceId);
    return yield* batch(
      input.sessionIds,
      (id) => id,
      (id) =>
        Effect.gen(function* () {
          yield* HermesApi.deleteSession(connection, id).pipe(
            // Already gone in Hermes; the T3 side still goes.
            Effect.catchIf(
              (error) => error.status === 404,
              () => Effect.void,
            ),
            Effect.mapError((error) =>
              error.status === 409
                ? new HermesSessionsError({
                    message: "Hermes is mid-turn in this session. Stop it, then delete.",
                  })
                : fromApi(error),
            ),
          );
          yield* archive.remove(input.instanceId, id);
          const thread = bound.get(id);
          if (thread === undefined) return;
          yield* orchestrator
            .dispatch({
              type: "thread.delete",
              commandId: yield* commandId("delete"),
              threadId: thread.threadId,
            })
            .pipe(Effect.mapError(failed("Deleted in Hermes, but not the T3 thread.")));
        }),
    );
  });

  const listArchived: HermesSessions["Service"]["listArchived"] = archive.list.pipe(
    Effect.map((sessions) => ({ sessions })),
  );

  const unarchive: HermesSessions["Service"]["unarchive"] = Effect.fn("HermesSessions.unarchive")(
    function* (input) {
      const connection = yield* connectionOf(input.instanceId);
      yield* HermesApi.patchSession(connection, input.sessionId, { archived: false }).pipe(
        Effect.catchIf(
          (error) => error.status === 404,
          () => Effect.void,
        ),
        Effect.mapError(fromApi),
      );
      const entry = archive.get(input.instanceId, input.sessionId);
      if (entry?.threadId) yield* unarchiveThread(entry.threadId);
      yield* archive.remove(input.instanceId, input.sessionId);
      return {};
    },
  );

  const dashboard: HermesSessions["Service"]["dashboard"] = Effect.fn("HermesSessions.dashboard")(
    function* (input) {
      const settings = yield* settingsOf(input.instanceId);
      const connection = HermesApi.dashboardConnectionOf(settings);
      const request = (method: string, body?: unknown) =>
        HermesApi.dashboardRequest(connection, method, input.path, body).pipe(
          Effect.mapError(fromApi),
        );
      if (input.path === "/api/env") {
        // Keys are write-only from T3: report whether each is set, never a value.
        const body = yield* request(input.method, input.body);
        return { body: input.method === "GET" ? envStatusOnly(body) : {} };
      }
      if (input.method === "PUT" && input.path === "/api/config" && isRecord(input.body)) {
        // Hermes deep-merges `{config}` over its file; a placeholder sent back
        // unchanged keeps the stored secret instead of overwriting it.
        const current = yield* request("GET");
        const stored = isRecord(current) && isRecord(current.config) ? current.config : current;
        const body = { ...input.body, config: restoreSecrets(input.body.config, stored) };
        return { body: redactSecrets(yield* request("PUT", body)) };
      }
      return { body: redactSecrets(yield* request(input.method, input.body)) };
    },
  );

  /**
   * Turns T3 tools on or off for one Hermes instance. On mints the instance's
   * bridge key, pins every other platform to no MCP servers, adds the `t3-code`
   * server limited to T3's thread tools, and restarts the gateway; off puts
   * back what on changed. The restore snapshot is saved before Hermes is
   * touched, so a half-finished switch can always be turned off. The restart
   * is best effort: Hermes reloads config.yaml and .env on its own, and its
   * dashboard can't spawn a restart on some Windows hosts.
   */
  const t3Tools: HermesSessions["Service"]["t3Tools"] = Effect.fn("HermesSessions.t3Tools")(
    function* (input) {
      const config = yield* settingsOf(input.instanceId);
      const connection = HermesApi.dashboardConnectionOf(config);
      const call = (method: string, path: string, body?: unknown, missingIsFine = false) =>
        HermesApi.dashboardRequest(connection, method, path, body).pipe(
          Effect.catchIf(
            (error) => missingIsFine && error.status === 404,
            () => Effect.succeed(undefined),
          ),
          Effect.mapError(fromApi),
        );
      const save = Effect.fn("HermesSessions.t3Tools.save")(function* (
        patch: Record<string, unknown>,
      ) {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(failed("Could not read settings.")),
        );
        const instance = settings.providerInstances[input.instanceId];
        if (instance === undefined) {
          return yield* new HermesSessionsError({
            message: "That is not a Hermes Agent provider.",
          });
        }
        const current = isRecord(instance.config) ? instance.config : {};
        yield* serverSettings
          .updateProviderInstance({
            operation: "upsert",
            instanceId: input.instanceId,
            instance: { ...instance, config: { ...current, ...patch } },
          })
          .pipe(Effect.mapError(failed("Could not save the T3 tools settings.")));
      });
      const serverPath = `/api/mcp/servers/${T3_TOOLS_SERVER}`;
      const restartGateway = call("POST", "/api/gateway/restart").pipe(
        Effect.as({ restarted: true }),
        Effect.catch((error) =>
          Effect.logWarning("Hermes gateway restart refused", error).pipe(
            Effect.as({ restarted: false }),
          ),
        ),
      );

      if (!input.enabled) {
        yield* call("DELETE", serverPath, undefined, true);
        yield* call("DELETE", "/api/env", { key: T3_TOOLS_ENV_KEY }, true);
        const restore = parseT3ToolsRestore(config.t3ToolsRestore);
        if (restore !== undefined) {
          yield* call("PUT", "/api/config", {
            config: {
              platform_toolsets: restore.platforms,
              ...("disabledToolsets" in restore
                ? { agent: { disabled_toolsets: restore.disabledToolsets ?? null } }
                : {}),
            },
          });
        }
        yield* save({ t3Tools: false, t3ToolsKey: "", t3ToolsRestore: "" });
        return yield* restartGateway;
      }

      const url = httpUrlOf(input.url);
      if (url === undefined) {
        return yield* new HermesSessionsError({
          message: "Enter the T3 /mcp address Hermes can reach, such as https://<mac>.ts.net/mcp.",
        });
      }
      const current = yield* call("GET", "/api/config");
      const stored = isRecord(current) && isRecord(current.config) ? current.config : current;
      const hermesConfig = isRecord(stored) ? stored : {};
      const toolsets = isRecord(hermesConfig.platform_toolsets)
        ? hermesConfig.platform_toolsets
        : {};
      const agent = isRecord(hermesConfig.agent) ? hermesConfig.agent : {};
      const discordWasDefault = toolsetListOf(toolsets.discord) === undefined;
      const disabled = toolsetListOf(agent.disabled_toolsets) ?? [];
      // A second "on" keeps the first snapshot, never T3's own earlier writes.
      const restore =
        config.t3ToolsRestore ||
        JSON.stringify({
          platforms: Object.fromEntries(
            Object.keys(NON_API_PLATFORMS).map((platform) => [
              platform,
              toolsets[platform] ?? null,
            ]),
          ),
          ...(discordWasDefault ? { disabledToolsets: agent.disabled_toolsets ?? null } : {}),
        } satisfies T3ToolsRestore);
      const key = yield* crypto.randomBytes(32).pipe(
        Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
        Effect.mapError(failed("Could not create the T3 tools key.")),
      );
      yield* save({ t3Tools: true, t3ToolsUrl: url, t3ToolsKey: key, t3ToolsRestore: restore });

      // Pin the other platforms before the server exists, so none ever sees it.
      const pinned = Object.fromEntries(
        Object.entries(NON_API_PLATFORMS).map(([platform, fallback]) => {
          const list = (toolsetListOf(toolsets[platform]) ?? [fallback]).filter(
            (name) => name !== T3_TOOLS_SERVER,
          );
          return [platform, list.includes("no_mcp") ? list : [...list, "no_mcp"]];
        }),
      );
      yield* call("PUT", "/api/config", {
        config: {
          platform_toolsets: pinned,
          ...(discordWasDefault
            ? {
                agent: {
                  disabled_toolsets: [...new Set([...disabled, ...DISCORD_EXPLICIT_TOOLSETS])],
                },
              }
            : {}),
        },
      });
      yield* call("DELETE", serverPath, undefined, true);
      yield* call("POST", "/api/mcp/servers", {
        name: T3_TOOLS_SERVER,
        url,
        auth: "header",
        bearer_token: key,
      });
      yield* call("PUT", "/api/config", {
        config: { mcp_servers: { [T3_TOOLS_SERVER]: { tools: { include: T3_TOOLS } } } },
      });
      return yield* restartGateway;
    },
  );

  /**
   * The details card for any session of this instance, read from Hermes with
   * read-only GETs, the same read a Hermes thread's `sessionInsights.get` makes.
   * Nothing is imported or continued, so an unopened session stays unopened.
   */
  const insights: HermesSessions["Service"]["insights"] = Effect.fn("HermesSessions.insights")(
    function* (input) {
      const settings = yield* settingsOf(input.instanceId);
      const read = yield* HermesInsights.read({ settings, sessionId: input.sessionId }).pipe(
        Effect.timeout(INSIGHTS_TIMEOUT),
        Effect.mapError(failed("Hermes did not answer in time.")),
      );
      if (read.session === null && read.context === null) {
        return yield* new HermesSessionsError({ message: "Hermes did not return that session." });
      }
      // The agent runs where Hermes runs, not on this server.
      const host = hostOfUrl(settings.apiUrl);
      return {
        providerThreadId: ProviderThreadId.make(input.sessionId),
        instanceId: input.instanceId,
        driver: HERMES_DRIVER,
        // Hermes answered for the session itself, whether or not T3 runs it now.
        live: true,
        capturedAt: DateTime.formatIso(yield* DateTime.now),
        context: read.context,
        mcpServers: read.mcpServers,
        ...(host === undefined ? {} : { host }),
        ...(read.session === null ? {} : { session: read.session }),
        outputs: read.outputs,
      };
    },
  );

  return HermesSessions.of({
    list,
    providers,
    continueSession,
    update,
    deleteSessions,
    listArchived,
    unarchive,
    dashboard,
    t3Tools,
    insights,
  });
});

export const layer = Layer.effect(HermesSessions, make);
