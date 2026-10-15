/**
 * Antigravity CLI conversations, from its summary database
 * `~/.gemini/antigravity-cli/conversation_summaries.db`. Transcripts are not
 * stored in a readable form, so these sessions list without a live view.
 *
 * @module external-sessions/antigravitySource
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUrl from "node:url";

import * as Effect from "effect/Effect";

import {
  asCount,
  asString,
  type ExternalSessionInfo,
  type ExternalSessionSource,
  firstLine,
  sessionDetails,
  timestampMs,
} from "./ExternalSessionSource.ts";
import { makeAntigravityUsage } from "./antigravityInsights.ts";

const DATABASE = "conversation_summaries.db";
const MAX_ROWS = 100;

const firstWorkspace = (value: unknown): string | null => {
  try {
    const uris: unknown = JSON.parse(typeof value === "string" ? value : "[]");
    const uri = Array.isArray(uris) ? asString(uris[0]) : null;
    return uri === null ? null : uri.startsWith("file:") ? NodeUrl.fileURLToPath(uri) : uri;
  } catch {
    return null;
  }
};

const readSummaries = (path: string): ReadonlyArray<ExternalSessionInfo> => {
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
    // The CLI owns the writer; never wait on it.
    database.exec("PRAGMA busy_timeout = 100");
    const rows = database
      .prepare(
        `SELECT conversation_id, title, preview, last_modified_time, last_user_input_time,
                workspace_uris, status, step_count
           FROM conversation_summaries
          WHERE nesting_depth = 0 OR nesting_depth IS NULL
          ORDER BY COALESCE(last_user_input_time, last_modified_time) DESC
          LIMIT ${MAX_ROWS}`,
      )
      .all();
    const infos: Array<ExternalSessionInfo> = [];
    for (const row of rows) {
      const id = asString(row.conversation_id);
      if (id === null) continue;
      const updatedAtMs = Math.max(
        timestampMs(row.last_modified_time, 0),
        timestampMs(row.last_user_input_time, 0),
      );
      const status = asString(row.status) ?? "";
      infos.push({
        id,
        title: firstLine(asString(row.title) ?? asString(row.preview) ?? "Untitled conversation"),
        cwd: firstWorkspace(row.workspace_uris),
        model: null,
        origin: "CLI",
        updatedAtMs,
        busy: status.includes("RUNNING"),
        details: sessionDetails(id, { stepCount: asCount(row.step_count) }),
      });
    }
    return infos;
  } catch {
    return [];
  } finally {
    database?.close();
  }
};

export const makeAntigravitySource = (): ExternalSessionSource => {
  const root = NodePath.join(NodeOS.homedir(), ".gemini", "antigravity-cli");
  const database = NodePath.join(root, DATABASE);
  const usage = makeAntigravityUsage(NodePath.join(root, "conversations"));

  return {
    driver: "antigravity",
    roots: [{ path: root, recursive: false }],
    sessionPathsFor: (changed) =>
      Effect.succeed(NodePath.basename(changed).startsWith(DATABASE) ? [database] : []),
    discover: () => Effect.succeed([database]),
    summarize: (path) =>
      Effect.gen(function* () {
        const infos = readSummaries(path);
        // The summary database names no model; the conversation's own does.
        // Only a new idle conversation triggers a decode here, so a running
        // one is not decoded again on every write.
        if (infos.some((info) => !info.busy && !usage.attempted(info.id))) yield* usage.refresh;
        return infos.map((info) => {
          const model = usage.model(info.id);
          return model === null ? info : { ...info, model };
        });
      }),
    transcriptPath: () => null,
    readInsights: usage.readInsights,
    createParser: () => ({ push: () => [] }),
  };
};
