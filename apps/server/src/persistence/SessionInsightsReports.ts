/**
 * Fork add-on: session details. Each provider thread's last live session
 * insights report (context breakdown, MCP servers and, for agents that keep
 * one, the session record), so a stopped thread keeps its details card across
 * a server restart. The table is created by the fork's own migration ledger
 * (ForkMigrations.ts), never upstream's.
 *
 * @module persistence/SessionInsightsReports
 */
import {
  IsoDateTime,
  ProviderThreadId,
  SessionContextBreakdown,
  SessionMcpServer,
  SessionRecord,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceSqlError } from "./Errors.ts";
import { runForkMigrations } from "./ForkMigrations.ts";

/** Rows kept; the oldest reports past this are deleted on each write. */
const MAX_STORED_REPORTS = 500;

export const StoredSessionInsightsReport = Schema.Struct({
  providerThreadId: ProviderThreadId,
  threadId: ThreadId,
  capturedAt: IsoDateTime,
  context: Schema.NullOr(SessionContextBreakdown),
  mcpServers: Schema.NullOr(Schema.Array(SessionMcpServer)),
  session: Schema.optional(SessionRecord),
});
export type StoredSessionInsightsReport = typeof StoredSessionInsightsReport.Type;

const ReportRow = Schema.Struct({
  providerThreadId: ProviderThreadId,
  threadId: ThreadId,
  capturedAt: IsoDateTime,
  context: Schema.NullOr(Schema.fromJsonString(SessionContextBreakdown)),
  mcpServers: Schema.NullOr(Schema.fromJsonString(Schema.Array(SessionMcpServer))),
  session: Schema.NullOr(Schema.fromJsonString(SessionRecord)),
});
// A row written by another build, or damaged, is ignored rather than failing the card.
const decodeReportRow = Schema.decodeUnknownOption(ReportRow);

export class SessionInsightsReportRepository extends Context.Service<
  SessionInsightsReportRepository,
  {
    readonly get: (
      providerThreadId: ProviderThreadId,
    ) => Effect.Effect<Option.Option<StoredSessionInsightsReport>, PersistenceSqlError>;
    /** Replaces the thread's report and drops the oldest past the row cap. */
    readonly put: (report: StoredSessionInsightsReport) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/persistence/SessionInsightsReports/SessionInsightsReportRepository") {}

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The table is the fork's; a failed migration leaves reports in memory only.
  const ready = yield* runForkMigrations().pipe(
    Effect.as(true),
    Effect.catch((error) =>
      Effect.logWarning("session-insights.migration-failed", { error: error.message }).pipe(
        Effect.as(false),
      ),
    ),
  );

  const get = (providerThreadId: ProviderThreadId) =>
    ready
      ? sql`
          SELECT
            provider_thread_id AS "providerThreadId",
            thread_id AS "threadId",
            captured_at AS "capturedAt",
            context_json AS "context",
            mcp_servers_json AS "mcpServers",
            session_json AS "session"
          FROM session_insights_reports
          WHERE provider_thread_id = ${providerThreadId}
        `.pipe(
          Effect.mapError(sqlError("getSessionInsightsReport")),
          Effect.map((rows) =>
            Option.flatMap(Option.fromNullishOr(rows[0]), decodeReportRow).pipe(
              Option.map((row): StoredSessionInsightsReport => ({
                providerThreadId: row.providerThreadId,
                threadId: row.threadId,
                capturedAt: row.capturedAt,
                context: row.context,
                mcpServers: row.mcpServers,
                ...(row.session === null ? {} : { session: row.session }),
              })),
            ),
          ),
        )
      : Effect.succeed(Option.none<StoredSessionInsightsReport>());

  const put = (report: StoredSessionInsightsReport) =>
    ready
      ? sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO session_insights_reports (
                  provider_thread_id,
                  thread_id,
                  captured_at,
                  context_json,
                  mcp_servers_json,
                  session_json
                )
                VALUES (
                  ${report.providerThreadId},
                  ${report.threadId},
                  ${report.capturedAt},
                  ${report.context === null ? null : JSON.stringify(report.context)},
                  ${report.mcpServers === null ? null : JSON.stringify(report.mcpServers)},
                  ${report.session === undefined ? null : JSON.stringify(report.session)}
                )
                ON CONFLICT (provider_thread_id) DO UPDATE SET
                  thread_id = excluded.thread_id,
                  captured_at = excluded.captured_at,
                  context_json = excluded.context_json,
                  mcp_servers_json = excluded.mcp_servers_json,
                  session_json = excluded.session_json
              `;
              yield* sql`
                DELETE FROM session_insights_reports
                WHERE provider_thread_id NOT IN (
                  SELECT provider_thread_id
                  FROM session_insights_reports
                  ORDER BY captured_at DESC
                  LIMIT ${MAX_STORED_REPORTS}
                )
              `;
            }),
          )
          .pipe(Effect.mapError(sqlError("putSessionInsightsReport")))
      : Effect.void;

  return SessionInsightsReportRepository.of({ get, put });
});

export const layer = Layer.effect(SessionInsightsReportRepository, make);
