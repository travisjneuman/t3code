/**
 * Save to notes. "Save full copy" writes the thread's prompts and final
 * answers, without tool output, to one Markdown file in the saved-threads
 * folder; saving the same thread again rewrites that file. "Save summary"
 * sends the thread's own agent one message asking it to write a summary note
 * into the notes folder, filed by that folder's own instructions, so the
 * folder's rules decide where it goes. Both folders are server settings.
 * Fork add-on; see docs/user/save-and-export-threads.md#save-a-thread-to-your-notes.
 *
 * @module save-to-notes/SaveToNotes
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  SaveToNotesError,
  type SaveToNotesCopyResult,
  type SaveToNotesInput,
  type SaveToNotesSummaryResult,
  modelSelectionLabel,
  providerInstanceLabel,
  threadExchanges,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { expandHomePathWith } from "@t3tools/provider-core/server/pathExpansion";
import { ServerSettingsService } from "../serverSettings.ts";
import { exportFileName } from "../thread-export/projectionView.ts";

export class SaveToNotes extends Context.Service<
  SaveToNotes,
  {
    readonly saveCopy: (
      input: SaveToNotesInput,
    ) => Effect.Effect<SaveToNotesCopyResult, SaveToNotesError>;
    readonly requestSummary: (
      input: SaveToNotesInput,
    ) => Effect.Effect<SaveToNotesSummaryResult, SaveToNotesError>;
  }
>()("t3/save-to-notes/SaveToNotes") {}

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const SETTINGS_PATH = "Settings, General, Projects & threads";

const failed = (message: string) => (cause: unknown) => new SaveToNotesError({ message, cause });

const day = (value: DateTime.Utc) => DateTime.formatIso(value).slice(0, 10);

const quote = (text: string): string =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");

/** Prompts and final answers as Markdown. */
const renderCopy = (input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly projectTitle: string | null;
  readonly workspaceRoot: string | null;
  readonly savedAt: DateTime.Utc;
}): string => {
  const { projection } = input;
  const { thread } = projection;
  const frontmatter = [
    "---",
    "type: ai-artifact",
    "status: active",
    `created: ${day(thread.createdAt)}`,
    `updated: ${day(input.savedAt)}`,
    `project: ${JSON.stringify(input.projectTitle ?? "none")}`,
    "artifact_type: saved-thread",
    "source_tool: T3 Code",
    "sensitivity: private",
    "canonical_location: true",
    `t3_thread_id: ${JSON.stringify(thread.id)}`,
    ...(input.workspaceRoot === null ? [] : [`workspace: ${JSON.stringify(input.workspaceRoot)}`]),
    "---",
  ];
  const sections: Array<string> = [];
  let number = 0;
  for (const exchange of threadExchanges(projection)) {
    const { prompt, run, answer } = exchange;
    number += 1;
    const lines: Array<string> = [];
    if (prompt !== null && prompt.createdBy === "user") {
      // Server-created user messages are T3 actions you asked for: hand back, review swap, summaries.
      const heading = prompt.creationSource === "server" ? "Prompt (sent by T3)" : "Prompt";
      lines.push(`## ${number}. ${heading}`, "", quote(prompt.text));
    } else {
      lines.push(`## ${number}. Follow-up`, "", "_Started by T3 or an agent, not typed by you._");
    }
    const agent =
      run === null
        ? "Answer"
        : `Answer · ${providerInstanceLabel(projection, run.providerInstanceId)} · ${modelSelectionLabel(run.modelSelection)}`;
    lines.push("", `### ${agent}`, "");
    if (answer !== null && !answer.streaming) lines.push(answer.text.trimEnd());
    else if (run !== null && ACTIVE_RUN_STATUSES.has(run.status)) {
      lines.push("_Still working when this copy was saved._");
    } else lines.push(run === null ? "_No answer._" : `_No answer (${run.status})._`);
    sections.push(lines.join("\n"));
  }
  return [
    frontmatter.join("\n"),
    "",
    `# ${thread.title}`,
    "",
    `Saved from T3 Code on ${day(input.savedAt)}. Prompts and final answers only; tool output and intermediate messages are left out.`,
    "",
    sections.length === 0 ? "_This thread has no prompts yet._" : sections.join("\n\n"),
    "",
  ].join("\n");
};

/** `<title-slug>-<id tail>.md`: stable per thread, so saving again updates the same file. */
const copyFileName = (title: string, threadId: string): string => {
  const tail = threadId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-8);
  return exportFileName(title, "md").replace(/\.md$/, `-${tail || "thread"}.md`);
};

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  /** The setting as an existing absolute folder, or an error naming where to set it. */
  const folderSetting = (key: "notesDirectory" | "savedThreadsDirectory", label: string) =>
    Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(failed("Settings could not be read.")),
      );
      const raw = current[key].trim();
      if (raw.length === 0) {
        return yield* new SaveToNotesError({
          message: `Set the ${label} first (${SETTINGS_PATH}).`,
        });
      }
      const folder = expandHomePathWith(raw, path);
      if (!path.isAbsolute(folder)) {
        return yield* new SaveToNotesError({
          message: `The ${label} must be a full path, like ~/notes.`,
        });
      }
      const stat = yield* fileSystem.stat(folder).pipe(Effect.option);
      if (Option.isNone(stat) || stat.value.type !== "Directory") {
        return yield* new SaveToNotesError({ message: `The ${label} ${folder} does not exist.` });
      }
      return folder;
    });

  const readThread = (threadId: SaveToNotesInput["threadId"]) =>
    threadManagement
      .getThreadProjection(threadId)
      .pipe(Effect.mapError(failed("This thread could not be read.")));

  const saveCopy = Effect.fn("SaveToNotes.saveCopy")(function* (input: SaveToNotesInput) {
    const folder = yield* folderSetting("savedThreadsDirectory", "saved threads folder");
    const projection = yield* readThread(input.threadId);
    const project = yield* projects
      .get(projection.thread.projectId, { includeDeleted: true })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const contents = renderCopy({
      projection,
      projectTitle: Option.match(project, { onNone: () => null, onSome: (row) => row.title }),
      workspaceRoot: Option.match(project, {
        onNone: () => null,
        onSome: (row) => row.workspaceRoot,
      }),
      savedAt: yield* DateTime.now,
    });
    const filePath = path.join(folder, copyFileName(projection.thread.title, projection.thread.id));
    yield* writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(failed(`Could not write ${filePath}.`)),
    );
    return { path: filePath };
  });

  const requestSummary = Effect.fn("SaveToNotes.requestSummary")(function* (
    input: SaveToNotesInput,
  ) {
    const folder = yield* folderSetting("notesDirectory", "notes folder");
    const projection = yield* readThread(input.threadId);
    const id = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(failed("Could not ask for a summary.")),
    );
    const active = projection.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));
    const text = [
      "Save a summary of this conversation to my notes.",
      "",
      `Notes folder: ${folder}`,
      "",
      "Before writing, read that folder's own instructions (AGENTS.md or CLAUDE.md at its root, and any placement or routing policy they point to) and follow them for where the note goes, its file name, its frontmatter, and any commit or sync steps. If the folder has no instructions, put the note at its root.",
      "",
      "Cover what this conversation was about, what was decided or done, and anything still open. Change nothing else in the folder unless its instructions require it. Reply with the note's path.",
    ].join("\n");
    yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "server",
        commandId: CommandId.make(`save-to-notes-summary:${id}`),
        threadId: input.threadId,
        messageId: MessageId.make(`save-to-notes-summary:${id}`),
        text,
        attachments: [],
        modelSelection: projection.thread.modelSelection,
        dispatchMode: active ? { type: "queue_after_active" } : { type: "start_immediately" },
      })
      .pipe(Effect.mapError(failed("Could not ask for a summary.")));
    return {};
  });

  return SaveToNotes.of({ saveCopy, requestSummary });
});

export const layer = Layer.effect(SaveToNotes, make);
