/**
 * Thread export: renders one thread's persisted orchestration projection as a
 * Markdown transcript or complete JSON. Reads the full projection through
 * ThreadManagementService (which restores legacy transcripts first), never the
 * client's loaded window, so every run and item T3 stored is included.
 * Fork add-on: thread export.
 *
 * @module thread-export/ThreadExport
 */
import {
  type ProjectId,
  ThreadExportError,
  type ThreadExportInput,
  type ThreadExportResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { renderThreadJson } from "./json.ts";
import { renderThreadMarkdown } from "./markdown.ts";
import { type ExportProject, exportFileName } from "./projectionView.ts";
import { redactProjection } from "./redact.ts";

export class ThreadExport extends Context.Service<
  ThreadExport,
  {
    readonly export: (
      input: ThreadExportInput,
    ) => Effect.Effect<ThreadExportResult, ThreadExportError>;
  }
>()("t3/thread-export/ThreadExport") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;

  // The workspace path is context, not content: a missing or unreadable
  // project row leaves it out instead of failing the export.
  const readProject = (projectId: ProjectId) =>
    projects.get(projectId, { includeDeleted: true }).pipe(
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: (row): ExportProject => ({
            id: row.projectId,
            title: row.title,
            workspaceRoot: row.workspaceRoot,
          }),
        }),
      ),
      Effect.orElseSucceed(() => null),
    );

  const exportThread = Effect.fn("ThreadExport.export")(function* (input: ThreadExportInput) {
    const stored = yield* threadManagement
      .getThreadProjection(input.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new ThreadExportError({ message: "This thread could not be read.", cause }),
        ),
      );
    const project = yield* readProject(stored.thread.projectId);
    const exportedAt = DateTime.formatIso(yield* DateTime.now);
    const { projection, omissions } = redactProjection(stored);

    if (input.format === "json") {
      const content = yield* renderThreadJson({ projection, project, exportedAt, omissions }).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadExportError({ message: "This thread could not be encoded as JSON.", cause }),
        ),
      );
      return {
        fileName: exportFileName(projection.thread.title, "json"),
        mimeType: "application/json",
        content,
      };
    }
    return {
      fileName: exportFileName(projection.thread.title, "md"),
      mimeType: "text/markdown",
      content: renderThreadMarkdown({ projection, project, exportedAt }),
    };
  });

  return ThreadExport.of({ export: exportThread });
});

export const layer = Layer.effect(ThreadExport, make);
