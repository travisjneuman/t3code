/**
 * Live view of agent sessions running outside T3: Claude Code, Codex, Grok,
 * Pi, and Antigravity, from CLIs, desktop apps, and IDE extensions. Each
 * provider's own session store is watched while anyone subscribes and is
 * never written to. Continuing an idle Claude, Codex, Grok, or Pi session
 * binds a T3 thread to that same session (continueExternalSession.ts), after
 * which it is listed as that thread instead. Handing one to a different agent
 * makes a separate thread from its history and leaves the session listed.
 * Archiving one hides it from the list (externalSessionArchive.ts) and, for
 * Codex, archives it in Codex too (codexNativeArchive.ts). Claude sessions
 * archived in Claude desktop are hidden and listed as archived too, read-only
 * (claudeDesktopArchive.ts). Fork add-on; see docs/internals/external-sessions.md.
 *
 * @module external-sessions/ExternalSessions
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type ExternalSessionArchiveInput,
  type ExternalSessionArchiveResult,
  type ExternalSessionArchivedResult,
  type ExternalSessionArchivedSession,
  type ExternalSessionHandBackResult,
  type ExternalSessionOpenInOriginResult,
  type ExternalSessionReleaseResult,
  ExternalSessionBusyError,
  type ExternalSessionContinueInput,
  type ExternalSessionContinueResult,
  ExternalSessionError,
  ExternalSessionNotFoundError,
  ExternalSessionUnsupportedError,
  externalSessionUnsupportedReason,
  type ExternalSessionEvent,
  type ExternalSessionListResult,
  type ExternalSessionMessage,
  type ExternalSessionSummary,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as RcRef from "effect/RcRef";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { makeAntigravitySource } from "./antigravitySource.ts";
import * as ClaudeDesktopArchive from "./claudeDesktopArchive.ts";
import * as HandBack from "./handBack.ts";
import * as OpenInOrigin from "./openInOrigin.ts";
import { makeClaudeSource } from "./claudeSource.ts";
import * as CodexNativeArchive from "./codexNativeArchive.ts";
import { makeCodexSource } from "./codexSource.ts";
import * as ContinueExternalSession from "./continueExternalSession.ts";
import * as ExternalSessionArchive from "./externalSessionArchive.ts";
import * as ExternalSessionSync from "./externalSessionSync.ts";
import {
  type ExternalSessionInfo,
  type ExternalSessionSource,
  readLines,
} from "./ExternalSessionSource.ts";
import { makeGrokSource } from "./grokSource.ts";
import { makePiSource } from "./piSource.ts";
import { findSessionPaths } from "./sessionHistory.ts";

const LIST_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_LISTED = 60;
const RUNNING_MS = 60 * 1000;
const IDLE_MS = 60 * 60 * 1000;
// Batches a burst of writes (a streamed reply) into one re-read.
const FLUSH_DELAY = "600 millis";
const LIVENESS_INTERVAL = "15 seconds";
const OWNED_REFRESH_MS = 30 * 1000;
const SNAPSHOT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_MESSAGES = 200;
const FOLLOW_BYTES = 8 * 1024 * 1024;

export class ExternalSessions extends Context.Service<
  ExternalSessions,
  {
    /** The newest sessions; a full list on subscribe and after every change. */
    readonly subscribeList: Stream.Stream<ExternalSessionListResult>;
    /** One session: a snapshot of its newest messages, then appends as it grows. */
    readonly subscribeSession: (
      key: string,
    ) => Stream.Stream<ExternalSessionEvent, ExternalSessionError>;
    /**
     * Import an idle session as a T3 thread; returns the existing thread when
     * already done.
     */
    readonly continueSession: (
      input: ExternalSessionContinueInput,
    ) => Effect.Effect<
      ExternalSessionContinueResult,
      | ExternalSessionNotFoundError
      | ExternalSessionBusyError
      | ExternalSessionUnsupportedError
      | ExternalSessionError
    >;
    /**
     * Continued threads whose session the other app is working in right now:
     * the whole set on subscribe, then again only when it changes.
     */
    readonly subscribeRunningElsewhere: Stream.Stream<ReadonlyArray<ThreadId>>;
    /**
     * Native session ids and session paths that T3 threads own, re-read at
     * most every 30 seconds. Session search leaves these to T3's own search.
     */
    readonly ownedSessionIds: Effect.Effect<ReadonlySet<string>>;
    /**
     * Hide a session from the list until unarchived; Codex sessions are
     * archived in Codex too unless `native` is false. Refused while running.
     */
    readonly archiveSession: (
      input: ExternalSessionArchiveInput,
    ) => Effect.Effect<
      ExternalSessionArchiveResult,
      ExternalSessionNotFoundError | ExternalSessionError
    >;
    /** List the session again, restoring it in Codex when Codex archived it. */
    readonly unarchiveSession: (
      key: string,
    ) => Effect.Effect<ExternalSessionArchiveResult, ExternalSessionError>;
    /**
     * Archived sessions, newest first, including listable Claude sessions
     * archived in Claude desktop; the whole set on subscribe and after every change.
     */
    readonly subscribeArchived: Stream.Stream<ExternalSessionArchivedResult>;
    /**
     * Send one short message on the agent a continued thread came from, so
     * what other agents did lands in its own session (handBack.ts).
     */
    readonly handBack: (
      threadId: ThreadId,
    ) => Effect.Effect<ExternalSessionHandBackResult, ExternalSessionError>;
    /**
     * Archive a continued thread so its session is listed again; continuing
     * the session unarchives it (handBack.ts).
     */
    readonly release: (
      threadId: ThreadId,
    ) => Effect.Effect<ExternalSessionReleaseResult, ExternalSessionError>;
    /** Opens the app a session runs in on that session (openInOrigin.ts). */
    readonly openInOrigin: (
      key: string,
    ) => Effect.Effect<ExternalSessionOpenInOriginResult, ExternalSessionError>;
  }
>()("t3/external-sessions/ExternalSessions") {}

interface Entry {
  readonly source: ExternalSessionSource;
  readonly path: string;
  readonly info: ExternalSessionInfo;
}

interface Registry {
  readonly entries: Map<string, Entry>;
  readonly list: SubscriptionRef.SubscriptionRef<ExternalSessionListResult>;
  /** Sessions the list hides because Claude desktop archived them, newest first. */
  readonly archivedInClaude: SubscriptionRef.SubscriptionRef<
    ReadonlyArray<ExternalSessionArchivedSession>
  >;
  /** Session paths whose files changed, after each flush. */
  readonly changed: PubSub.PubSub<ReadonlySet<string>>;
  readonly summaryFor: (key: string) => ExternalSessionSummary | null;
  /** Republishes the list, e.g. after an archive change. */
  readonly publish: Effect.Effect<void>;
  /** Re-reads which sessions T3 owns and republishes the list. */
  readonly refreshOwned: Effect.Effect<void>;
  /**
   * The listed entry for `key`, or else one looked up on demand in the
   * history window (an older search result), which then stays registered.
   */
  readonly resolve: (key: string) => Effect.Effect<Entry | undefined>;
}

const sessionKey = (source: ExternalSessionSource, id: string) => `${source.driver}:${id}`;

const isUnder = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(NodePath.sep) ? root : `${root}${NodePath.sep}`);

// Pi names a session by its file; the listing names it by the id inside.
const PI_SESSION_FILE = /_([0-9a-f-]{36})\.jsonl$/i;

// Every string in a resume cursor: provider session ids under whatever key the adapter uses.
const collectStrings = (value: unknown, into: Set<string>, depth = 0): void => {
  if (typeof value === "string") into.add(value);
  else if (depth < 4 && typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) collectStrings(child, into, depth + 1);
  }
};

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const providerSessions = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const sql = yield* SqlClient.SqlClient;
  const continueExternalSession = yield* ContinueExternalSession.make;
  const archive = yield* ExternalSessionArchive.make;
  const codexNativeArchive = yield* CodexNativeArchive.make;
  const claudeDesktopArchive = yield* ClaudeDesktopArchive.make;
  const { handBack, release: releaseThread } = yield* HandBack.make;
  const origins = yield* OpenInOrigin.make(claudeDesktopArchive);
  const sources: ReadonlyArray<ExternalSessionSource> = [
    makeClaudeSource(),
    makeCodexSource(),
    makeGrokSource(),
    makePiSource(),
    makeAntigravitySource(),
  ];
  // Runs for the server's lifetime, apart from the listing's watchers.
  const sync = yield* ExternalSessionSync.make((driver) => {
    const source = sources.find((candidate) => candidate.driver === driver);
    return source === undefined ? { push: () => [] } : source.createParser();
  });
  // Sessions T3 started itself (scratch threads, worktrees) already show as T3 threads.
  const excludedRoots = [
    config.baseDir,
    config.worktreesDir,
    NodePath.join(NodeOS.homedir(), ".t3"),
  ];
  const provide = Effect.provideService(FileSystem.FileSystem, fileSystem);

  // Sessions T3 threads own. Runtime rows cover imported Claude and Codex
  // sessions, including ones whose thread later fell back to a fresh native
  // session. Threads T3 started itself, and continued Grok and Pi sessions,
  // have none; their provider threads name the native session (an id, or Pi's
  // file path). Kept for the server's lifetime, so search shares it. An
  // archived continued thread owns nothing, so its session is listed again
  // ("Move back to Other Agents", handBack.ts); continuing it unarchives it.
  let owned: ReadonlySet<string> = new Set();
  let ownedAt = 0;
  const readReleasedThreadIds = sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE thread_id LIKE 'import:%' AND archived_at IS NOT NULL
  `.pipe(
    Effect.map((rows): ReadonlySet<string> => new Set(rows.map((row) => row.thread_id))),
    Effect.orElseSucceed((): ReadonlySet<string> => new Set()),
  );
  const readRuntimeOwned = (released: ReadonlySet<string>) =>
    providerSessions.list().pipe(
      Effect.map((rows) => {
        const ids = new Set<string>();
        for (const row of rows) {
          if (!released.has(row.threadId)) collectStrings(row.resumeCursor, ids);
        }
        return ids;
      }),
      Effect.orElseSucceed(() => new Set<string>()),
    );
  const readProviderThreadOwned = sql<{ readonly native_id: string | null }>`
    SELECT json_extract(p.payload_json, '$.nativeThreadRef.nativeId') AS native_id
    FROM orchestration_v2_projection_provider_threads p
    LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
    WHERE json_valid(p.payload_json) AND t.deleted_at IS NULL
      AND NOT (p.thread_id LIKE 'import:%' AND t.archived_at IS NOT NULL)
  `.pipe(
    Effect.map((rows) => {
      const ids = new Set<string>();
      for (const row of rows) {
        if (typeof row.native_id !== "string") continue;
        ids.add(row.native_id);
        const piId = PI_SESSION_FILE.exec(row.native_id)?.[1];
        if (piId !== undefined) ids.add(piId);
      }
      return ids;
    }),
    Effect.orElseSucceed(() => new Set<string>()),
  );
  const refreshOwnedIds = readReleasedThreadIds.pipe(
    Effect.flatMap((released) =>
      Effect.all([readRuntimeOwned(released), readProviderThreadOwned], { concurrency: 2 }),
    ),
    Effect.map(([fromRuntime, fromProviderThreads]): ReadonlySet<string> => {
      owned = new Set([...fromRuntime, ...fromProviderThreads]);
      ownedAt = Date.now();
      return owned;
    }),
  );
  const ownedSessionIds: ExternalSessions["Service"]["ownedSessionIds"] = Effect.suspend(() =>
    Date.now() - ownedAt <= OWNED_REFRESH_MS ? Effect.succeed(owned) : refreshOwnedIds,
  );

  const acquireRegistry = Effect.gen(function* () {
    const entries = new Map<string, Entry>();
    const keysByPath = new Map<string, ReadonlyArray<string>>();
    const hiddenPaths = new Set<string>();
    const list = yield* SubscriptionRef.make<ExternalSessionListResult>({ sessions: [] });
    const archivedInClaude = yield* SubscriptionRef.make<
      ReadonlyArray<ExternalSessionArchivedSession>
    >([]);
    const changed = yield* PubSub.unbounded<ReadonlySet<string>>();

    const toSummary = (key: string, entry: Entry, now: number): ExternalSessionSummary => ({
      key,
      driver: entry.source.driver,
      origin: entry.info.origin,
      title: entry.info.title,
      cwd: entry.info.cwd,
      model: entry.info.model,
      updatedAt: new Date(entry.info.updatedAtMs).toISOString(),
      liveness:
        entry.info.busy || now - entry.info.updatedAtMs < RUNNING_MS
          ? "running"
          : now - entry.info.updatedAtMs < IDLE_MS
            ? "idle"
            : "recent",
    });

    const isListed = (entry: Entry, now: number) =>
      now - entry.info.updatedAtMs < LIST_WINDOW_MS &&
      !owned.has(entry.info.id) &&
      !owned.has(entry.path) &&
      !(entry.info.cwd !== null && excludedRoots.some((root) => isUnder(entry.info.cwd!, root)));

    const publish = Effect.gen(function* () {
      yield* ownedSessionIds;
      const inClaude = yield* claudeDesktopArchive.archivedIds;
      const claudeDesktopHas = yield* claudeDesktopArchive.hasRecord;
      const now = Date.now();
      // Tagged as Claude desktop's but unknown to it: deleted there, or a
      // background run that inherited its tag. Claude desktop doesn't list it.
      const unknownToClaudeDesktop = (entry: Entry) =>
        entry.source.driver === "claudeAgent" &&
        entry.info.origin === "Desktop" &&
        claudeDesktopHas !== null &&
        !claudeDesktopHas(entry.info.id);
      const listable = [...entries].filter(
        ([, entry]) => isListed(entry, now) && !unknownToClaudeDesktop(entry),
      );
      // Claude desktop's archive hides a Claude session just as T3's does.
      const claudeArchivedAt = (entry: Entry) =>
        entry.source.driver === "claudeAgent" ? inClaude.get(entry.info.id) : undefined;
      const sessions = listable
        .filter(
          ([key, entry]) => archive.get(key) === undefined && claudeArchivedAt(entry) === undefined,
        )
        .sort(([, a], [, b]) => b.info.updatedAtMs - a.info.updatedAtMs)
        .slice(0, MAX_LISTED)
        .map(([key, entry]) => toSummary(key, entry, now));
      const current = yield* SubscriptionRef.get(list);
      if (JSON.stringify(current.sessions) !== JSON.stringify(sessions)) {
        yield* SubscriptionRef.set(list, { sessions });
      }
      const mirrored = listable
        .flatMap(([key, entry]): Array<ExternalSessionArchivedSession> => {
          const archivedAtMs = claudeArchivedAt(entry);
          if (archivedAtMs === undefined) return [];
          return [
            {
              key,
              driver: entry.source.driver,
              title: entry.info.title,
              cwd: entry.info.cwd,
              archivedAt: new Date(archivedAtMs).toISOString(),
              nativeArchived: false,
              archivedIn: "claudeDesktop",
            },
          ];
        })
        .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
      const currentMirrored = yield* SubscriptionRef.get(archivedInClaude);
      if (JSON.stringify(currentMirrored) !== JSON.stringify(mirrored)) {
        yield* SubscriptionRef.set(archivedInClaude, mirrored);
      }
    });

    const summarizePath = (source: ExternalSessionSource, path: string) =>
      Effect.gen(function* () {
        if (hiddenPaths.has(path)) return;
        const result = yield* provide(source.summarize(path));
        for (const key of keysByPath.get(path) ?? []) entries.delete(key);
        if (result === "hidden") {
          hiddenPaths.add(path);
          keysByPath.delete(path);
          return;
        }
        const keys = result.map((info) => {
          const key = sessionKey(source, info.id);
          entries.set(key, { source, path, info });
          return key;
        });
        keysByPath.set(path, keys);
      });

    // Initial discovery, before the first subscriber sees the list.
    yield* refreshOwnedIds;
    const since = Date.now() - LIST_WINDOW_MS;
    yield* Effect.forEach(
      sources,
      (source) =>
        provide(source.discover(since)).pipe(
          Effect.flatMap((paths) =>
            Effect.forEach(paths, (path) => summarizePath(source, path), { discard: true }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
    yield* publish;

    // File events collect here; one flush re-reads each touched session once.
    const pending = new Map<string, ExternalSessionSource>();
    const wake = yield* Queue.sliding<void>(1);
    const watchRoot = (
      source: ExternalSessionSource,
      root: ExternalSessionSource["roots"][number],
    ) =>
      fileSystem.watch(root.path, { recursive: root.recursive }).pipe(
        Stream.mapEffect((event) =>
          provide(source.sessionPathsFor(NodePath.resolve(root.path, event.path))),
        ),
        Stream.runForEach((paths) =>
          Effect.gen(function* () {
            if (paths.length === 0) return;
            for (const path of paths) pending.set(path, source);
            yield* Queue.offer(wake, undefined);
          }),
        ),
        // A missing store just means that agent is not installed here.
        Effect.ignore,
      );
    yield* Effect.forEach(
      sources.flatMap((source) => source.roots.map((root) => watchRoot(source, root))),
      (watch) => Effect.forkScoped(watch),
      { discard: true },
    );

    const flush = Effect.gen(function* () {
      yield* Queue.take(wake);
      yield* Effect.sleep(FLUSH_DELAY);
      const batch = [...pending];
      pending.clear();
      yield* Effect.forEach(batch, ([path, source]) => summarizePath(source, path), {
        discard: true,
      });
      yield* publish;
      yield* PubSub.publish(changed, new Set(batch.map(([path]) => path)));
    });
    yield* Effect.forkScoped(Effect.forever(flush));
    // Liveness is time-based: "running" decays to "idle" without any file event.
    yield* Effect.forkScoped(Effect.repeat(publish, Schedule.spaced(LIVENESS_INTERVAL)));

    const registry: Registry = {
      entries,
      list,
      archivedInClaude,
      changed,
      publish,
      summaryFor: (key) => {
        const entry = entries.get(key);
        // Details ride only on the session stream; the list stays lean.
        return entry === undefined
          ? null
          : { ...toSummary(key, entry, Date.now()), details: entry.info.details };
      },
      refreshOwned: Effect.andThen(refreshOwnedIds, publish),
      resolve: (key) =>
        Effect.gen(function* () {
          const listed = entries.get(key);
          if (listed !== undefined) return listed;
          const separator = key.indexOf(":");
          const driver = key.slice(0, separator);
          const source = sources.find((candidate) => candidate.driver === driver);
          if (separator <= 0 || source === undefined) return undefined;
          // Summarizing registers the entry, and the store's watcher (already
          // running) keeps it current; the list still shows only its window.
          for (const path of yield* provide(findSessionPaths(source, key.slice(separator + 1)))) {
            yield* summarizePath(source, path);
            const found = entries.get(key);
            if (found !== undefined) return found;
          }
          return undefined;
        }),
    };
    return registry;
  });

  const registryRef = yield* RcRef.make({
    acquire: acquireRegistry,
    // Keep the watchers through a quick reconnect or route change.
    idleTimeToLive: "30 seconds",
  });

  const subscribeList: ExternalSessions["Service"]["subscribeList"] = Stream.unwrap(
    Effect.map(RcRef.get(registryRef), (registry) => SubscriptionRef.changes(registry.list)),
  );

  const subscribeSession: ExternalSessions["Service"]["subscribeSession"] = (key) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const registry = yield* RcRef.get(registryRef);
        const entry = yield* registry.resolve(key);
        const summary = registry.summaryFor(key);
        if (entry === undefined || summary === null) {
          return yield* Effect.fail(
            new ExternalSessionError({ message: "That session is no longer available." }),
          );
        }
        // Subscribe before the snapshot read so no append is missed in between.
        const changes = yield* PubSub.subscribe(registry.changed);
        const transcript = entry.source.transcriptPath(entry.path);
        const parser = entry.source.createParser();

        const snapshotSlice =
          transcript === null
            ? null
            : yield* provide(readLines(transcript, { fromEnd: true, maxBytes: SNAPSHOT_BYTES }));
        const messages = new Map<string, ExternalSessionMessage>();
        for (const line of snapshotSlice?.lines ?? []) {
          for (const message of parser.push(line)) messages.set(message.id, message);
        }
        const all = [...messages.values()];
        const snapshot: ExternalSessionEvent = {
          _tag: "snapshot",
          summary,
          messages: all.slice(-SNAPSHOT_MESSAGES),
          truncated: (snapshotSlice?.start ?? 0) > 0 || all.length > SNAPSHOT_MESSAGES,
        };

        let offset = snapshotSlice?.end ?? 0;
        let lastSummary = JSON.stringify(summary);
        const readAppended = Effect.gen(function* () {
          const out: Array<ExternalSessionEvent> = [];
          if (transcript !== null) {
            const appended: Array<ExternalSessionMessage> = [];
            // Loop so a large burst is read in bounded chunks.
            for (;;) {
              const slice = yield* provide(
                readLines(transcript, { from: offset, maxBytes: FOLLOW_BYTES }),
              );
              if (slice === null) break;
              // The file was replaced or truncated; continue from its new end.
              if (slice.size < offset) {
                offset = slice.size;
                break;
              }
              if (slice.end === offset) {
                // Either a line is still being written, or one line outgrows a
                // whole chunk (a huge tool result); skip that one to the tail.
                if (slice.size - offset < FOLLOW_BYTES) break;
                const tail = yield* provide(
                  readLines(transcript, { fromEnd: true, maxBytes: FOLLOW_BYTES }),
                );
                if (tail === null) break;
                for (const line of tail.lines) appended.push(...parser.push(line));
                offset = tail.end;
                break;
              }
              for (const line of slice.lines) appended.push(...parser.push(line));
              offset = slice.end;
              if (offset >= slice.size) break;
            }
            if (appended.length > 0) out.push({ _tag: "append", messages: appended });
          }
          const next = registry.summaryFor(key);
          if (next !== null && JSON.stringify(next) !== lastSummary) {
            lastSummary = JSON.stringify(next);
            out.push({ _tag: "summary", summary: next });
          }
          return out;
        });

        const fileChanges = Stream.fromSubscription(changes).pipe(
          Stream.filter((paths) => paths.has(entry.path)),
        );
        // Liveness decays without file events; the list ticks it.
        const listChanges = SubscriptionRef.changes(registry.list);
        return Stream.make(snapshot).pipe(
          Stream.concat(
            Stream.merge(fileChanges, listChanges).pipe(
              Stream.mapEffect(() => readAppended),
              Stream.flattenIterable,
            ),
          ),
        );
      }),
    );

  const continueSession: ExternalSessions["Service"]["continueSession"] = ({ key }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* RcRef.get(registryRef);
        const entry = registry.entries.get(key);
        const summary = registry.summaryFor(key);
        if (entry === undefined || summary === null) {
          return yield* new ExternalSessionNotFoundError({ key });
        }
        if (summary.liveness === "running") {
          return yield* new ExternalSessionBusyError({ key });
        }
        const reason = externalSessionUnsupportedReason(summary);
        const transcriptPath = entry.source.transcriptPath(entry.path);
        const driver = summary.driver;
        if (
          reason !== null ||
          summary.cwd === null ||
          transcriptPath === null ||
          !ContinueExternalSession.isContinueDriver(driver)
        ) {
          return yield* new ExternalSessionUnsupportedError({ key, reason: reason ?? "provider" });
        }
        const target: ContinueExternalSession.ContinueTarget = {
          key,
          driver,
          sessionId: entry.info.id,
          title: entry.info.title,
          cwd: summary.cwd,
          model: entry.info.model,
          effort: entry.info.details.effort ?? null,
          transcriptPath,
          updatedAtMs: entry.info.updatedAtMs,
          createParser: entry.source.createParser,
        };
        const { syncStart, ...result } = yield* continueExternalSession.continueSession(target);
        // The session now belongs to a T3 thread; drop it from the list right away.
        yield* registry.refreshOwned;
        // From here on, what the other app appends shows up in the thread.
        if (syncStart !== null) yield* sync.register(syncStart);
        return result;
      }),
    );

  const archiveSession: ExternalSessions["Service"]["archiveSession"] = ({ key, native }) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (archive.get(key) !== undefined) return { warning: null };
        const registry = yield* RcRef.get(registryRef);
        const entry = yield* registry.resolve(key);
        const summary = registry.summaryFor(key);
        if (entry === undefined || summary === null) {
          return yield* new ExternalSessionNotFoundError({ key });
        }
        // It may be in use in the other app; Codex would archive it mid-turn.
        if (summary.liveness === "running") {
          return yield* new ExternalSessionError({
            message: "This session is still running. Stop it in the other app, then archive it.",
          });
        }
        const archived = {
          key,
          driver: summary.driver,
          title: summary.title,
          cwd: summary.cwd,
          archivedAt: new Date().toISOString(),
          nativeArchived: false,
        };
        // T3 first, so the row leaves the list without waiting on Codex.
        yield* archive.put(archived);
        yield* registry.publish;
        if (native === false || summary.driver !== "codex") return { warning: null };
        const warning = yield* codexNativeArchive.run("thread/archive", entry.info.id);
        if (warning === null) yield* archive.put({ ...archived, nativeArchived: true });
        return { warning };
      }),
    );

  const unarchiveSession: ExternalSessions["Service"]["unarchiveSession"] = (key) =>
    Effect.scoped(
      Effect.gen(function* () {
        const archived = archive.get(key);
        if (archived === undefined) return { warning: null };
        // Codex first, so the rollout is back where the list reads it.
        const warning = archived.nativeArchived
          ? yield* codexNativeArchive.run("thread/unarchive", key.slice(key.indexOf(":") + 1))
          : null;
        yield* archive.remove(key);
        const registry = yield* RcRef.get(registryRef);
        yield* registry.publish;
        return { warning };
      }),
    );

  // Holds the registry, which knows the titles of sessions Claude desktop archived.
  const subscribeArchived: ExternalSessions["Service"]["subscribeArchived"] = Stream.unwrap(
    Effect.map(RcRef.get(registryRef), (registry) =>
      Stream.zipLatestWith(
        SubscriptionRef.changes(archive.sessions),
        SubscriptionRef.changes(registry.archivedInClaude),
        (inT3, inClaude) => ({ sessions: mergeArchived(inT3, inClaude) }),
      ),
    ),
  );

  // The session is listed again right away, not on the next ownership re-read.
  const release: ExternalSessions["Service"]["release"] = (threadId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* releaseThread(threadId);
        const registry = yield* RcRef.get(registryRef);
        yield* registry.refreshOwned;
        return result;
      }),
    );

  const openInOrigin: ExternalSessions["Service"]["openInOrigin"] = (key) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* RcRef.get(registryRef);
        const entry = yield* registry.resolve(key);
        const summary = registry.summaryFor(key);
        if (entry === undefined || summary === null) {
          return yield* new ExternalSessionError({ message: "This session is no longer listed." });
        }
        return yield* origins.openInOrigin({
          driver: summary.driver,
          origin: summary.origin,
          sessionId: entry.info.id,
        });
      }),
    );

  return ExternalSessions.of({
    subscribeList,
    subscribeSession,
    continueSession,
    subscribeRunningElsewhere: sync.runningElsewhere,
    ownedSessionIds,
    archiveSession,
    unarchiveSession,
    subscribeArchived,
    handBack,
    release,
    openInOrigin,
  });
});

/**
 * T3's archive plus Claude desktop's, newest first. A session in both shows
 * T3's entry, whose Unarchive still applies; it stays hidden after that.
 */
const mergeArchived = (
  inT3: ReadonlyArray<ExternalSessionArchivedSession>,
  inClaude: ReadonlyArray<ExternalSessionArchivedSession>,
): ReadonlyArray<ExternalSessionArchivedSession> => {
  if (inClaude.length === 0) return inT3;
  const keys = new Set(inT3.map((session) => session.key));
  return [...inT3, ...inClaude.filter((session) => !keys.has(session.key))].sort((left, right) =>
    right.archivedAt.localeCompare(left.archivedAt),
  );
};

export const layer = Layer.effect(ExternalSessions, make).pipe(
  Layer.provide(TurnItemPositionStore.layer),
);
