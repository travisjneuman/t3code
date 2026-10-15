import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork add-on: session details. Each provider thread's last live session
 * insights report, so a stopped thread keeps its full details card across a
 * server restart. Only creates; nothing else reads or writes this table, and
 * upstream builds ignore it.
 *
 * Rollback: `DROP TABLE IF EXISTS session_insights_reports;` and
 * `DELETE FROM fork_sql_migrations WHERE migration_id = 1;`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS session_insights_reports (
      provider_thread_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      context_json TEXT,
      mcp_servers_json TEXT,
      session_json TEXT
    )
  `;
});
