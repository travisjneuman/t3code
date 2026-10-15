import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork add-on: session details. Stores the files a Hermes session changed and
 * the machine its report came from, with the rest of the last report.
 *
 * Rollback: `ALTER TABLE session_insights_reports DROP COLUMN outputs_json;`,
 * `ALTER TABLE session_insights_reports DROP COLUMN host;` and
 * `DELETE FROM fork_sql_migrations WHERE migration_id = 2;`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE session_insights_reports ADD COLUMN outputs_json TEXT`;
  yield* sql`ALTER TABLE session_insights_reports ADD COLUMN host TEXT`;
});
