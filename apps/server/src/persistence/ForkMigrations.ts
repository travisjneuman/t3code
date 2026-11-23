/**
 * Fork add-on: fork migrations use their own `fork_sql_migrations` ledger, because upstream's
 * migrator skips every id at or below the highest recorded, so a fork id would mask a future
 * upstream one. Tables only, which upstream builds sharing `~/.t3` ignore.
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import ForkMigration0001 from "./ForkMigrations/001_SessionInsightsReports.ts";
import ForkMigration0002 from "./ForkMigrations/002_SessionInsightsOutputs.ts";
import ForkMigration0003 from "./ForkMigrations/003_ProjectLinks.ts";

const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

/**
 * Key format `{id}_{name}`, as upstream's loader; ids are the fork's own sequence.
 * Keep every entry when an add-on is left out: the migrator skips ids below the highest run.
 */
const forkMigrationEntries = [
  [1, "SessionInsightsReports", ForkMigration0001], // Fork add-on(session-details)
  [2, "SessionInsightsOutputs", ForkMigration0002], // Fork add-on(session-details)
  [3, "ProjectLinks", ForkMigration0003], // Fork add-on(project-links)
] as const;

const loader = Migrator.fromRecord(
  Object.fromEntries(
    forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
  ),
);

const run = Migrator.make({});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executed = yield* run({ loader, table: FORK_MIGRATIONS_TABLE });
  if (executed.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
