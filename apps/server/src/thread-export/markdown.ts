/**
 * Renders a thread projection as a readable Markdown transcript. Nothing is
 * cut: commands, outputs, diffs and tool values go in fences sized past any
 * backtick run they contain. Fields the transcript only summarizes (message
 * context records, native provider refs, attempts) are complete in the JSON
 * export. Fork add-on: thread export.
 *
 * @module thread-export/markdown
 */
import type {
  ChatAttachment,
  ModelSelection,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  carriesImportedHistory,
  type ExportProject,
  hiddenTurnItemIds,
  inheritedTurnItems,
} from "./projectionView.ts";

type TurnItem = OrchestrationV2TurnItem;
type Projection = OrchestrationV2ThreadProjection;

const when = (value: DateTime.Utc | null | undefined): string | null =>
  value == null
    ? null
    : DateTime.formatIso(value)
        .replace("T", " ")
        .replace(/(\.\d+)?Z$/, " UTC");

const count = (value: number): string => value.toLocaleString("en-US");

const compact = (parts: ReadonlyArray<string | null | undefined | false>): Array<string> =>
  parts.filter((part): part is string => typeof part === "string" && part.length > 0);

/** Inline code that survives backticks in the value. */
const code = (value: string): string => {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const marker = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${marker}${pad}${value}${pad}${marker}`;
};

/** A fenced block longer than any backtick fence inside `content`, so it can never close early. */
const fence = (content: string, info = ""): string => {
  let longest = 0;
  for (const match of content.matchAll(/`{3,}/g)) longest = Math.max(longest, match[0].length);
  const marker = "`".repeat(Math.max(3, longest + 1));
  const body = content.endsWith("\n") ? content : `${content}\n`;
  return `${marker}${info}\n${body}${marker}`;
};

const valueText = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

const valueBlock = (value: unknown): string =>
  fence(valueText(value), typeof value === "string" ? "text" : "json");

const quote = (text: string): string =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");

const modelLabel = (selection: ModelSelection): string => {
  const options =
    selection.options === undefined
      ? []
      : selection.options.map((option) => `${option.id}=${String(option.value)}`);
  return options.length === 0 ? selection.model : `${selection.model} (${options.join(", ")})`;
};

const attachmentLines = (attachments: ReadonlyArray<ChatAttachment>): string | null =>
  attachments.length === 0
    ? null
    : [
        "Attachments (file contents are not included):",
        ...attachments.map(
          (attachment) =>
            `- ${attachment.name} (${attachment.mimeType}, ${count(attachment.sizeBytes)} bytes)`,
        ),
      ].join("\n");

// Partial so an item type added upstream still renders, under its raw type name.
const ITEM_LABELS: Readonly<Partial<Record<TurnItem["type"], string>>> = {
  notification: "Notification",
  user_message: "User",
  assistant_message: "Assistant",
  reasoning: "Reasoning",
  proposed_plan: "Proposed plan",
  todo_list: "To-do list",
  user_input_request: "Question for the user",
  file_change: "File change",
  command_execution: "Command",
  file_search: "File search",
  web_search: "Web search",
  approval_request: "Approval request",
  checkpoint: "Checkpoint",
  run_interrupt_request: "Interrupt requested",
  run_interrupt_result: "Interrupted",
  system_notice: "Notice",
  error: "Error",
  compaction: "Context compaction",
  handoff: "Context handoff",
  fork: "Fork",
  thread_created: "Thread created",
  subagent: "Subagent",
  dynamic_tool: "Tool call",
};

const itemHeading = (item: TurnItem, hidden: boolean): string => {
  const label = ITEM_LABELS[item.type] ?? item.type;
  const title = item.title !== null && item.title.trim() !== "" && item.title !== label;
  const meta = compact([
    when(item.startedAt ?? item.completedAt ?? item.updatedAt),
    item.status === "completed" ? null : item.status,
    hidden && "not shown in T3's timeline",
  ]);
  return compact([
    `#### ${label}${title ? `: ${item.title}` : ""}`,
    meta.length > 0 && `_${meta.join(" · ")}_`,
  ]).join("\n");
};

const itemBody = (item: TurnItem, projection: Projection): Array<string> => {
  switch (item.type) {
    case "user_message":
      return compact([
        item.text,
        attachmentLines(item.attachments),
        item.context !== undefined &&
          item.context.records.length > 0 &&
          [
            "Context attached:",
            ...item.context.records.map((record) => `- ${record.kind}: ${record.label}`),
          ].join("\n"),
        (item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer") &&
          "_Sent while the agent was working (steer)._",
      ]);
    case "assistant_message":
      return compact([
        item.text,
        attachmentLines(item.attachments ?? []),
        item.streaming && "_Incomplete: the message was still streaming._",
      ]);
    case "reasoning":
      return compact([item.text.trim() !== "" && quote(item.text)]);
    case "proposed_plan":
      return [item.markdown];
    case "todo_list":
      return compact([
        item.explanation,
        item.steps
          .map(
            (step) =>
              `- [${step.status === "completed" ? "x" : " "}] ${step.text}${step.status === "running" ? " (in progress)" : ""}`,
          )
          .join("\n"),
      ]);
    case "user_input_request": {
      const answers =
        item.questionAnswer?.answers ??
        projection.runtimeRequests.find((request) => request.id === item.requestId)?.answers;
      return compact([
        ...item.questions.map((question) =>
          [
            `**${question.header}:** ${question.question}`,
            ...question.options.map((option) => `- ${option.label}: ${option.description}`),
          ].join("\n"),
        ),
        answers !== undefined && `Answer:\n\n${valueBlock(answers)}`,
      ]);
    }
    case "file_change": {
      const counts = compact([
        item.additions !== undefined && `+${count(item.additions)}`,
        item.deletions !== undefined && `-${count(item.deletions)}`,
      ]);
      return compact([
        `${code(item.fileName)}${counts.length > 0 ? ` (${counts.join(" ")})` : ""}`,
        item.changes !== undefined &&
          item.changes.length > 0 &&
          item.changes
            .map(
              (change) =>
                `- ${change.operation} ${code(change.path)}${change.oldPath === undefined ? "" : ` (from ${code(change.oldPath)})`}`,
            )
            .join("\n"),
        item.diffStr !== undefined && item.diffStr !== "" && fence(item.diffStr, "diff"),
        item.oldStr !== undefined && `Before:\n\n${fence(item.oldStr)}`,
        item.newStr !== undefined && `After:\n\n${fence(item.newStr)}`,
      ]);
    }
    case "command_execution":
      return compact([
        fence(item.input, "sh"),
        item.exitCode !== undefined && `Exit code: ${item.exitCode}`,
        item.output !== undefined && item.output !== ""
          ? `Output:\n\n${fence(item.output, "text")}`
          : "_No output recorded._",
      ]);
    case "file_search":
      return compact([
        item.pattern !== undefined && `Pattern: ${code(item.pattern)}`,
        item.results !== undefined &&
          item.results.length > 0 &&
          item.results
            .map(
              (result) =>
                `- ${code(`${result.fileName}${result.line === undefined ? "" : `:${result.line}`}${result.column === undefined ? "" : `:${result.column}`}`)}${result.preview === undefined ? "" : ` ${result.preview}`}`,
            )
            .join("\n"),
      ]);
    case "web_search":
      return compact([
        item.patterns !== undefined &&
          item.patterns.length > 0 &&
          `Queries: ${item.patterns.map(code).join(", ")}`,
        item.results !== undefined &&
          item.results.length > 0 &&
          item.results
            .map((result) =>
              compact([
                `- ${result.title ?? result.url ?? "Result"}`,
                result.url !== undefined && result.title !== undefined && `<${result.url}>`,
                result.snippet,
              ]).join(" "),
            )
            .join("\n"),
      ]);
    case "approval_request": {
      const decision = projection.runtimeRequests.find(
        (request) => request.id === item.requestId,
      )?.decision;
      return compact([
        `Kind: ${item.requestKind}${item.appName === undefined ? "" : ` (${item.appName})`}`,
        item.prompt !== undefined && fence(item.prompt, "text"),
        item.options !== undefined &&
          item.options.length > 0 &&
          `Options: ${item.options.map((option) => option.label).join(", ")}`,
        decision !== undefined && `Decision: ${decision}`,
      ]);
    }
    case "checkpoint":
      return [
        item.files.length === 0
          ? "_No file changes._"
          : item.files
              .map(
                (file) =>
                  `- ${file.kind} ${code(file.path)} (+${count(file.additions)} -${count(file.deletions)})`,
              )
              .join("\n"),
      ];
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return [item.message];
    case "error":
      return compact([
        fence(item.failure.message, "text"),
        compact([
          `Class: ${item.failure.class}`,
          item.failure.code !== null && `code: ${item.failure.code}`,
          item.failure.retryable !== null && `retryable: ${item.failure.retryable}`,
          item.retry !== undefined &&
            `retry ${item.retry.attempt}${item.retry.maxAttempts === null ? "" : ` of ${item.retry.maxAttempts}`}`,
        ]).join(" · "),
      ]);
    case "compaction":
      return compact([
        compact([
          item.beforeTokenCount !== undefined && `Before: ${count(item.beforeTokenCount)} tokens`,
          item.afterTokenCount !== undefined && `after: ${count(item.afterTokenCount)} tokens`,
        ]).join(" · "),
        item.summary !== undefined && item.summary !== "" && `Summary:\n\n${fence(item.summary)}`,
      ]);
    case "handoff": {
      const summary =
        item.summary ??
        projection.contextHandoffs.find((handoff) => handoff.id === item.contextHandoffId)
          ?.summaryText;
      return compact([
        compact([
          `Strategy: ${item.strategy}`,
          `from ${item.fromProviderInstanceIds.map(code).join(", ") || "none"}`,
          `to ${code(item.toProviderInstanceId)}${item.toModel === undefined ? "" : ` (${item.toModel})`}`,
        ]).join(" · "),
        summary !== undefined && summary !== "" && `Summary handed over:\n\n${fence(summary)}`,
      ]);
    }
    case "fork":
      return [
        item.source.type === "run"
          ? `Forked from run ${code(item.source.runId)} of thread ${code(item.source.threadId)}.`
          : item.source.type === "node"
            ? `Forked from node ${code(item.source.nodeId)}.`
            : `Forked from provider thread ${code(item.source.providerThreadId)}.`,
      ];
    case "thread_created":
      return [
        `Created thread ${code(item.targetThreadId)} on ${code(item.targetProviderInstanceId)} (${item.targetModel}).`,
      ];
    case "subagent":
      return compact([
        compact([
          `${item.driver} (${code(item.providerInstanceId)})`,
          item.origin === "app_owned" ? "started by T3" : "started by the provider",
          item.childThreadId !== null && `thread ${code(item.childThreadId)}`,
        ]).join(" · "),
        `Prompt:\n\n${fence(item.prompt)}`,
        item.progress !== undefined &&
          item.progress !== "" &&
          `Progress:\n\n${fence(item.progress)}`,
        item.result !== null && `Result:\n\n${fence(item.result)}`,
      ]);
    case "dynamic_tool":
      return compact([
        item.toolName !== null && `Tool: ${code(item.toolName)}`,
        item.viewedImagePath !== undefined && `Viewed image: ${code(item.viewedImagePath)}`,
        `Input:\n\n${valueBlock(item.input)}`,
        item.output !== undefined && `Output:\n\n${valueBlock(item.output)}`,
      ]);
    case "notification":
      return compact([
        `${item.summary} (${item.source.kind}, ${item.outcome})`,
        item.detail !== undefined && item.detail !== "" && fence(item.detail, "text"),
      ]);
    default: {
      // A type added upstream after this exporter: keep its data visible.
      const unknownItem: TurnItem = item;
      return [valueBlock(unknownItem)];
    }
  }
};

const renderItem = (item: TurnItem, projection: Projection, hidden: boolean): string =>
  [itemHeading(item, hidden), ...itemBody(item, projection)].join("\n\n");

const providerTurnsOf = (
  run: OrchestrationV2Run,
  projection: Projection,
): Array<OrchestrationV2ProviderTurn> => {
  const attempts = projection.attempts.filter((attempt) => attempt.runId === run.id);
  const attemptIds = new Set(attempts.map((attempt) => attempt.id));
  const turnIds = new Set(attempts.flatMap((attempt) => attempt.providerTurnId ?? []));
  return projection.providerTurns.filter(
    (turn) =>
      (turn.runAttemptId !== null && attemptIds.has(turn.runAttemptId)) || turnIds.has(turn.id),
  );
};

const tokenLine = (turns: ReadonlyArray<OrchestrationV2ProviderTurn>): string | null => {
  const usages = turns.flatMap((turn) => turn.turnTokenUsage ?? []);
  const parts: Array<string> = [];
  if (usages.length > 0) {
    const sum = (pick: (usage: (typeof usages)[number]) => number | undefined) =>
      usages.reduce((total, usage) => total + (pick(usage) ?? 0), 0);
    const cached = sum((usage) => usage.cachedInputTokens);
    const reasoning = sum((usage) => usage.reasoningTokens);
    parts.push(
      `${count(sum((usage) => usage.inputTokens))} in${cached > 0 ? ` (${count(cached)} cached)` : ""}`,
      `${count(sum((usage) => usage.outputTokens))} out${reasoning > 0 ? ` (${count(reasoning)} reasoning)` : ""}`,
    );
    if (usages.some((usage) => usage.usageStatus !== "complete")) parts.push("partial");
  }
  const context = turns.findLast((turn) => turn.tokenUsage !== undefined)?.tokenUsage;
  if (context !== undefined) {
    parts.push(
      `context ${count(context.usedTokens)}${context.maxTokens == null ? "" : ` of ${count(context.maxTokens)}`}`,
    );
  }
  return parts.length === 0 ? null : `Tokens: ${parts.join(" · ")}`;
};

const driverOf = (run: OrchestrationV2Run, projection: Projection): string | null =>
  (
    projection.providerThreads.find((thread) => thread.id === run.providerThreadId) ??
    projection.providerThreads.find(
      (thread) => thread.providerInstanceId === run.providerInstanceId,
    ) ??
    projection.providerSessions.find(
      (session) => session.providerInstanceId === run.providerInstanceId,
    )
  )?.driver ?? null;

const runTitle = (run: OrchestrationV2Run, projection: Projection): string => {
  const driver = driverOf(run, projection);
  return `Run ${run.ordinal} · ${driver === null ? "" : `${driver} `}(${code(run.providerInstanceId)}) · ${modelLabel(run.modelSelection)}`;
};

const runMeta = (run: OrchestrationV2Run, projection: Projection): string =>
  compact([
    `_${compact([
      `Status: ${run.status}`,
      `requested ${when(run.requestedAt)}`,
      run.startedAt !== null && `started ${when(run.startedAt)}`,
      run.completedAt !== null && `finished ${when(run.completedAt)}`,
    ]).join(" · ")}_`,
    tokenLine(providerTurnsOf(run, projection)),
  ]).join("\n");

const historyLabel = (projection: Projection): string =>
  projection.thread.id.startsWith("import:")
    ? "Continued from a session that ran outside T3; its earlier history is imported"
    : projection.thread.historyOrigin === "v1_import"
      ? "Imported from T3's earlier storage"
      : "Native T3 thread";

const forkLabel = (projection: Projection): string | null => {
  const forkedFrom = projection.thread.forkedFrom;
  if (forkedFrom === null) return null;
  switch (forkedFrom.type) {
    case "run":
      return `run ${code(forkedFrom.runId)} of thread ${code(forkedFrom.threadId)}`;
    case "node":
      return `node ${code(forkedFrom.nodeId)}`;
    case "provider_thread":
      return `provider thread ${code(forkedFrom.providerThreadId)}`;
  }
};

const header = (
  projection: Projection,
  project: ExportProject | null,
  exportedAt: string,
): string => {
  const { thread, runs, turnItems } = projection;
  const lineage = thread.lineage;
  const lines = compact([
    `- **Thread:** ${code(thread.id)}`,
    project !== null && `- **Project:** ${project.title} (${code(project.workspaceRoot)})`,
    thread.branch !== null && `- **Branch:** ${code(thread.branch)}`,
    thread.worktreePath !== null && `- **Worktree:** ${code(thread.worktreePath)}`,
    `- **Created:** ${when(thread.createdAt)} · **Updated:** ${when(thread.updatedAt)}`,
    thread.archivedAt !== null && `- **Archived:** ${when(thread.archivedAt)}`,
    thread.deletedAt !== null && `- **Deleted:** ${when(thread.deletedAt)}`,
    `- **History:** ${historyLabel(projection)}`,
    forkLabel(projection) !== null && `- **Forked from:** ${forkLabel(projection)}`,
    lineage.parentThreadId !== null &&
      `- **Parent thread:** ${code(lineage.parentThreadId)}${lineage.relationshipToParent === null ? "" : ` (${lineage.relationshipToParent})`} · **Root thread:** ${code(lineage.rootThreadId)}`,
    `- **Current model:** ${code(thread.providerInstanceId)} · ${modelLabel(thread.modelSelection)}`,
    `- **Mode:** ${thread.runtimeMode} · ${thread.interactionMode}`,
    `- **Runs:** ${count(runs.length)} · **Items:** ${count(turnItems.length)}`,
    `- **Exported:** ${exportedAt}`,
  ]);
  return [
    `# ${thread.title}`,
    lines.join("\n"),
    quote(
      "Exported from T3 Code. Nothing in this transcript is truncated. Attachments are listed by name only. The JSON export of this thread holds the complete structured data.",
    ),
  ].join("\n\n");
};

const inheritedSection = (
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  projection: Projection,
): Array<string> => {
  if (rows.length === 0) return [];
  const blocks = [
    "## Inherited history",
    "_This thread is a fork. T3 shows this history from its source thread before the thread's own items._",
  ];
  let sourceThreadId: string | null = null;
  for (const row of rows) {
    if (row.sourceThreadId !== sourceThreadId) {
      sourceThreadId = row.sourceThreadId;
      blocks.push(`### From thread ${code(row.sourceThreadId)}`);
    }
    blocks.push(renderItem(row.item, projection, false));
  }
  return blocks;
};

const transcriptSection = (projection: Projection): Array<string> => {
  const hidden = hiddenTurnItemIds(projection);
  const runsById = new Map(projection.runs.map((run) => [run.id, run]));
  const blocks = ["## Transcript"];
  if (projection.turnItems.length === 0) {
    blocks.push("_No items recorded._");
    return blocks;
  }
  const seenRuns = new Set<string>();
  let group: string | undefined;
  for (const item of projection.turnItems) {
    const key = item.runId ?? "";
    if (key !== group) {
      group = key;
      const run = item.runId === null ? undefined : runsById.get(item.runId);
      if (item.runId === null) {
        blocks.push(
          seenRuns.size === 0 && carriesImportedHistory(projection)
            ? "### Imported history"
            : "### Thread events",
        );
      } else if (run === undefined) {
        blocks.push(`### Run ${code(item.runId)}`);
      } else {
        const continued = seenRuns.has(run.id);
        seenRuns.add(run.id);
        blocks.push(
          `### ${runTitle(run, projection)}${continued ? " (continued)" : ""}`,
          ...(continued ? [] : [runMeta(run, projection)]),
        );
      }
    }
    blocks.push(renderItem(item, projection, hidden.has(item.id)));
  }
  return blocks;
};

const runsSection = (projection: Projection): Array<string> =>
  projection.runs.length === 0
    ? []
    : [
        "## Runs",
        projection.runs
          .map((run) => {
            const meta = runMeta(run, projection).split("\n").join("\n  ");
            return `- **${runTitle(run, projection)}**\n  ${meta}`;
          })
          .join("\n"),
      ];

/** Messages with no transcript item, such as system messages. */
const otherMessagesSection = (projection: Projection): Array<string> => {
  const inTranscript = new Set(
    [...projection.turnItems, ...projection.visibleTurnItems.map((row) => row.item)].flatMap(
      (item) =>
        item.type === "user_message" || item.type === "assistant_message" ? [item.messageId] : [],
    ),
  );
  const others = projection.messages.filter((message) => !inTranscript.has(message.id));
  if (others.length === 0) return [];
  return [
    "## Other messages",
    ...others.map((message) =>
      compact([
        `#### ${message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "System"}\n_${when(message.createdAt)}_`,
        message.text,
        attachmentLines(message.attachments),
      ]).join("\n\n"),
    ),
  ];
};

export const renderThreadMarkdown = (input: {
  readonly projection: Projection;
  readonly project: ExportProject | null;
  readonly exportedAt: string;
}): string =>
  `${[
    header(input.projection, input.project, input.exportedAt),
    ...inheritedSection(inheritedTurnItems(input.projection), input.projection),
    ...transcriptSection(input.projection),
    ...runsSection(input.projection),
    ...otherMessagesSection(input.projection),
  ].join("\n\n")}\n`;
