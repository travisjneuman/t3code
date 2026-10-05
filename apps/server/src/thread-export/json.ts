/**
 * Builds the JSON thread export: the thread's persisted projection, encoded
 * with the same `*Json` schemas the wire uses, under a versioned envelope.
 *
 * Top-level shape (version 1):
 * - `format`: "t3-thread-export"; `version`: 1; `exportedAt`: ISO time.
 * - `thread`: the thread record (title, model selection, lineage, forkedFrom,
 *   historyOrigin, timestamps).
 * - `project`: `{ id, title, workspaceRoot }`, or null when the project is gone.
 * - `runs`: every run, by ordinal.
 * - `items`: every item the thread owns, by ordinal. Runless items (imported
 *   history, thread events) have `runId: null` and sit in their place.
 * - `hiddenItemIds`: items in `items` that T3's timeline does not show.
 * - `inheritedItems`: for forks, the source history shown before `items`.
 * - `records`: the remaining projection records (attempts, nodes, subagents,
 *   providerSessions, providerThreads, providerTurns with token usage,
 *   runtimeRequests, messages, plans, checkpointScopes, checkpoints,
 *   contextHandoffs, contextTransfers).
 * - `projectionUpdatedAt`: when the projection last changed.
 * - `omitted`: counts of what the export removed (see redact.ts).
 *
 * Fork add-on: thread export.
 *
 * @module thread-export/json
 */
import {
  OrchestrationV2ThreadProjectionJson,
  THREAD_EXPORT_JSON_FORMAT,
  THREAD_EXPORT_JSON_VERSION,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type ExportProject, hiddenTurnItemIds } from "./projectionView.ts";
import type { ThreadExportOmissions } from "./redact.ts";

const encodeProjection = Schema.encodeEffect(OrchestrationV2ThreadProjectionJson);

export const renderThreadJson = (input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly project: ExportProject | null;
  readonly exportedAt: string;
  readonly omissions: ThreadExportOmissions;
}) =>
  encodeProjection(input.projection).pipe(
    Effect.map((encoded) => {
      const { thread, runs, turnItems, visibleTurnItems, updatedAt, ...records } = encoded;
      const document = {
        format: THREAD_EXPORT_JSON_FORMAT,
        version: THREAD_EXPORT_JSON_VERSION,
        exportedAt: input.exportedAt,
        thread,
        project: input.project,
        runs,
        items: turnItems,
        hiddenItemIds: [...hiddenTurnItemIds(input.projection)],
        inheritedItems: visibleTurnItems.filter((row) => row.visibility !== "local"),
        records,
        projectionUpdatedAt: updatedAt,
        omitted: input.omissions,
      };
      return `${JSON.stringify(document, null, 2)}\n`;
    }),
  );
