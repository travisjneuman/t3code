/**
 * Live view of agent sessions running outside T3: Claude Code, Codex, Grok,
 * Pi, and Antigravity, from CLIs, desktop apps, and IDE extensions. Each
 * provider's own session store is watched while anyone subscribes and is
 * never written to. Continuing an idle Claude, Codex, Grok, or Pi session
 * binds a T3 thread to that same session (continueExternalSession.ts), after
 * which it is listed as that thread instead. Fork add-on; see
 * docs/internals/external-sessions.md.
 *
 * @module external-sessions/ExternalSessions
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ExternalSessionBusyError,
  type ExternalSessionContinueResult,
  ExternalSessionError,
  ExternalSessionNotFoundError,
  ExternalSessionUnsupportedError,
  externalSessionUnsupportedReason,
  type ExternalSessionEvent,
  type ExternalSessionListResult,
  type ExternalSessionMessage,
  type ExternalSessionSummary,
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
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { makeAntigravitySource } from "./antigravitySource.ts";
import { makeClaudeSource } from "./claudeSource.ts";
import { makeCodexSource } from "./codexSource.ts";
import * as ContinueExternalSession from "./continueExternalSession.ts";
import {
  type ExternalSessionInfo,
  type ExternalSessionSource,
  readLines,
} from "./ExternalSessionSource.ts";
import { makeGrokSource } from "./grokSource.ts";
import { makePiSource } from "./piSource.ts";

const LIST_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
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
    /** Import an idle session as a T3 thread; returns the existing thread when already done. */
    readonly continueSession: (
      key: string,
    ) => Effect.Effect<
      ExternalSessionContinueResult,
      | ExternalSessionNotFoundError
      | ExternalSessionBusyError
      | ExternalSessionUnsupportedError
      | ExternalSessionError
    >;
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
  /** Session paths whose files changed, after each flush. */
  readonly changed: PubSub.PubSub<ReadonlySet<string>>;
  readonly summaryFor: (key: string) => ExternalSessionSummary | null;
  /** Re-reads which sessions T3 owns and republishes the list. */
  readonly refreshOwned: Effect.Effect<void>;
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
  const sources: ReadonlyArray<ExternalSessionSource> = [
    makeClaudeSource(),
    makeCodexSource(),
    makeGrokSource(),
    makePiSource(),
    makeAntigravitySource(),
  ];
  // Sessions T3 started itself (scratch threads, worktrees) already show as T3 threads.
  const excludedRoots = [
    config.baseDir,
    config.worktreesDir,
    NodePath.join(NodeOS.homedir(), ".t3"),
  ];
  const provide = Effect.provideService(FileSystem.FileSystem, fileSystem);

  const acquireRegistry = Effect.gen(function* () {
    const entries = new Map<string, Entry>();
    const keysByPath = new Map<string, ReadonlyArray<string>>();
    const hiddenPaths = new Set<string>();
    const list = yield* SubscriptionRef.make<ExternalSessionListResult>({ sessions: [] });
    const changed = yield* PubSub.unbounded<ReadonlySet<string>>();
    let owned = new Set<string>();
    let ownedAt = 0;

    // Runtime rows cover imported Claude and Codex sessions, including ones
    // whose thread later fell back to a fresh native session. Threads T3
    // started itself, and continued Grok and Pi sessions, have none; their
    // provider threads name the native session (an id, or Pi's file path).
    const readRuntimeOwned = providerSessions.list().pipe(
      Effect.map((rows) => {
        const ids = new Set<string>();
        for (const row of rows) collectStrings(row.resumeCursor, ids);
        return ids;
      }),
      Effect.orElseSucceed(() => new Set<string>()),
    );
    const readProviderThreadOwned = sql<{ readonly native_id: string | null }>`
      SELECT json_extract(p.payload_json, '$.nativeThreadRef.nativeId') AS native_id
      FROM orchestration_v2_projection_provider_threads p
      LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
      WHERE json_valid(p.payload_json) AND t.deleted_at IS NULL
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
    const refreshOwned = Effect.all([readRuntimeOwned, readProviderThreadOwned], {
      concurrency: 2,
    }).pipe(
      Effect.map(([fromRuntime, fromProviderThreads]) => {
        owned = new Set([...fromRuntime, ...fromProviderThreads]);
        ownedAt = Date.now();
      }),
    );

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
      if (Date.now() - ownedAt > OWNED_REFRESH_MS) yield* refreshOwned;
      const now = Date.now();
      const sessions = [...entries]
        .filter(([, entry]) => isListed(entry, now))
        .sort(([, a], [, b]) => b.info.updatedAtMs - a.info.updatedAtMs)
        .slice(0, MAX_LISTED)
        .map(([key, entry]) => toSummary(key, entry, now));
      const current = yield* SubscriptionRef.get(list);
      if (JSON.stringify(current.sessions) !== JSON.stringify(sessions)) {
        yield* SubscriptionRef.set(list, { sessions });
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
    yield* refreshOwned;
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
      changed,
      summaryFor: (key) => {
        const entry = entries.get(key);
        return entry === undefined ? null : toSummary(key, entry, Date.now());
      },
      refreshOwned: Effect.andThen(refreshOwned, publish),
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
        const entry = registry.entries.get(key);
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

  const continueSession: ExternalSessions["Service"]["continueSession"] = (key) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* RcRef.get(registryRef);
        const entry = registry.entries.get(key);
        const summary = registry.summaryFor(key);
        if (entry === undefined || summary === null) {
          return yield* new ExternalSessionNotFoundError({ key });
        }
        if (summary.liveness === "running") return yield* new ExternalSessionBusyError({ key });
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
        const result = yield* continueExternalSession({
          key,
          driver,
          sessionId: entry.info.id,
          title: entry.info.title,
          cwd: summary.cwd,
          model: entry.info.model,
          transcriptPath,
          updatedAtMs: entry.info.updatedAtMs,
          createParser: entry.source.createParser,
        });
        // The session now belongs to a T3 thread; drop it from the list right away.
        yield* registry.refreshOwned;
        return result;
      }),
    );

  return ExternalSessions.of({ subscribeList, subscribeSession, continueSession });
});

export const layer = Layer.effect(ExternalSessions, make);
