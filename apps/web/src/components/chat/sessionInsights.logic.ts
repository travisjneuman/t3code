import type {
  ModelSelection,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeMode,
  SessionContextBreakdown,
  SessionContextCategoryKind,
  SessionContextContributor,
  SessionMcpServerStatus,
} from "@t3tools/contracts";
import { deriveReportedModelSelection } from "@t3tools/client-runtime/state/thread-execution";
import * as DateTime from "effect/DateTime";

/**
 * Pure derivations behind the thread details card's Session, Context,
 * Connectors, and Outputs sections. Fork add-on.
 */

type ProviderSessionStatus = OrchestrationV2ProviderSession["status"];
type FileChangeItem = Extract<OrchestrationV2TurnItem, { readonly type: "file_change" }>;

const SETTLED_PROVIDER_TURN_STATUSES = new Set(["completed", "interrupted", "failed", "cancelled"]);

/** The provider thread the app thread is on, and the session that hosts it. */
function resolveActiveProviderSession(projection: OrchestrationV2ThreadProjection): {
  readonly providerThread: OrchestrationV2ProviderThread | undefined;
  readonly session: OrchestrationV2ProviderSession | undefined;
} {
  const { thread } = projection;
  const providerThread =
    thread.activeProviderThreadId === null
      ? undefined
      : projection.providerThreads.find(
          (candidate) => candidate.id === thread.activeProviderThreadId,
        );
  const session =
    (providerThread?.providerSessionId
      ? projection.providerSessions.find(
          (candidate) => candidate.id === providerThread.providerSessionId,
        )
      : undefined) ??
    projection.providerSessions.findLast(
      (candidate) => candidate.providerInstanceId === thread.providerInstanceId,
    );
  return { providerThread, session };
}

/**
 * Changes when the latest provider turn settles, the session's status moves,
 * or the thread switches provider threads. Session insights refetch on it.
 */
export function deriveSessionInsightsRefreshKey(
  projection: OrchestrationV2ThreadProjection | null,
): string {
  if (projection === null) return "";
  const { providerThread, session } = resolveActiveProviderSession(projection);
  let settledTurn: OrchestrationV2ThreadProjection["providerTurns"][number] | undefined;
  if (providerThread !== undefined) {
    for (const turn of projection.providerTurns) {
      if (
        turn.providerThreadId === providerThread.id &&
        SETTLED_PROVIDER_TURN_STATUSES.has(turn.status) &&
        (settledTurn === undefined || turn.ordinal >= settledTurn.ordinal)
      ) {
        settledTurn = turn;
      }
    }
  }
  return [
    projection.thread.activeProviderThreadId ?? "",
    session?.status ?? "",
    settledTurn === undefined ? "" : `${settledTurn.id}:${settledTurn.status}`,
  ].join("|");
}

export interface ThreadSessionSummary {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind | null;
  readonly modelSelection: ModelSelection;
  readonly reportedModelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly sessionStatus: ProviderSessionStatus | null;
  readonly lastError: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  /** The thread's checked-out branch and worktree, for the Environment rows. */
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export function deriveThreadSessionSummary(
  projection: OrchestrationV2ThreadProjection,
): ThreadSessionSummary {
  const { thread } = projection;
  const { providerThread, session } = resolveActiveProviderSession(projection);
  return {
    providerInstanceId: session?.providerInstanceId ?? thread.providerInstanceId,
    driver: session?.driver ?? providerThread?.driver ?? null,
    modelSelection: thread.modelSelection,
    reportedModelSelection: deriveReportedModelSelection(projection),
    runtimeMode: thread.runtimeMode,
    sessionStatus: session?.status ?? null,
    lastError: session?.lastError ?? null,
    startedAt: DateTime.formatIso(session?.createdAt ?? thread.createdAt),
    updatedAt: DateTime.formatIso(session?.updatedAt ?? thread.updatedAt),
    turnCount: projection.runs.filter((run) => run.startedAt !== null).length,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
  };
}

/** Field-wise equality, so stream updates that leave the summary alone keep its identity. */
export function threadSessionSummaryEqual(
  left: ThreadSessionSummary,
  right: ThreadSessionSummary,
): boolean {
  return (Object.keys(left) as Array<keyof ThreadSessionSummary>).every((key) =>
    Object.is(left[key], right[key]),
  );
}

export const SESSION_STATUS_PRESENTATION: Record<
  ProviderSessionStatus | "none",
  { readonly label: string; readonly dotClassName: string }
> = {
  starting: { label: "Starting", dotClassName: "bg-info" },
  running: { label: "Working", dotClassName: "bg-info" },
  waiting: { label: "Waiting", dotClassName: "bg-warning" },
  ready: { label: "Live", dotClassName: "bg-success" },
  stopped: { label: "Idle", dotClassName: "bg-muted-foreground/45" },
  error: { label: "Error", dotClassName: "bg-destructive" },
  none: { label: "Not started", dotClassName: "bg-muted-foreground/45" },
};

export const MCP_SERVER_STATUS_PRESENTATION: Record<
  SessionMcpServerStatus,
  { readonly label: string; readonly dotClassName: string }
> = {
  connected: { label: "Connected", dotClassName: "bg-success" },
  pending: { label: "Pending", dotClassName: "bg-info" },
  "needs-auth": { label: "Needs auth", dotClassName: "bg-warning" },
  failed: { label: "Failed", dotClassName: "bg-destructive" },
  disabled: { label: "Disabled", dotClassName: "bg-muted-foreground/45" },
  configured: { label: "Configured", dotClassName: "bg-muted-foreground/45" },
};

// Theme palette tokens with dark-mode steps, so adjacent categories stay
// distinct on both canvases.
const CONTEXT_CATEGORY_COLOR_CLASSES = [
  "bg-sky-500 dark:bg-sky-400",
  "bg-violet-500 dark:bg-violet-400",
  "bg-amber-500 dark:bg-amber-400",
  "bg-emerald-500 dark:bg-emerald-400",
  "bg-rose-500 dark:bg-rose-400",
  "bg-teal-500 dark:bg-teal-400",
] as const;
const CONTEXT_BUFFER_COLOR_CLASS = "bg-muted-foreground/40";
const CONTEXT_FREE_COLOR_CLASS = "bg-muted-foreground/15";

export interface ContextCategoryRow {
  readonly name: string;
  readonly tokens: number;
  readonly kind: SessionContextCategoryKind;
  /** Share of the window; null for deferred rows, which sit outside it. */
  readonly percent: number | null;
  readonly colorClassName: string | null;
}

export interface ContextBreakdownView {
  readonly usedPercent: number | null;
  readonly rows: ReadonlyArray<ContextCategoryRow>;
  /** Bar segments in window order; free space is the bar's empty track. */
  readonly segments: ReadonlyArray<{
    readonly name: string;
    readonly percent: number;
    readonly colorClassName: string;
  }>;
}

export function deriveContextBreakdownView(context: SessionContextBreakdown): ContextBreakdownView {
  const windowTokens = context.maxTokens > 0 ? context.maxTokens : null;
  const percentOf = (tokens: number) =>
    windowTokens === null ? null : (tokens / windowTokens) * 100;
  let colorIndex = 0;
  const rows: ContextCategoryRow[] = [];
  for (const category of context.categories) {
    // Colors follow the provider's full category order, so hiding an empty
    // row does not repaint the rows after it.
    const colorClassName =
      category.kind === "used"
        ? CONTEXT_CATEGORY_COLOR_CLASSES[colorIndex++ % CONTEXT_CATEGORY_COLOR_CLASSES.length]!
        : category.kind === "buffer"
          ? CONTEXT_BUFFER_COLOR_CLASS
          : category.kind === "free"
            ? CONTEXT_FREE_COLOR_CLASS
            : null;
    if (category.tokens === 0) continue;
    rows.push({
      name: category.name,
      tokens: category.tokens,
      kind: category.kind,
      percent: category.kind === "deferred" ? null : percentOf(category.tokens),
      colorClassName,
    });
  }
  const segments: Array<ContextBreakdownView["segments"][number]> = [];
  let filled = 0;
  for (const row of rows) {
    if ((row.kind !== "used" && row.kind !== "buffer") || row.percent === null) continue;
    const percent = Math.min(row.percent, 100 - filled);
    if (percent <= 0 || row.colorClassName === null) continue;
    filled += percent;
    segments.push({ name: row.name, percent, colorClassName: row.colorClassName });
  }
  return { usedPercent: percentOf(context.totalTokens), rows, segments };
}

export interface ContributorGroup {
  readonly source: string | null;
  readonly count: number;
  readonly tokens: number;
}

/** MCP tools by the server that provides them, largest first. */
export function groupContributorsBySource(
  contributors: ReadonlyArray<SessionContextContributor>,
): ReadonlyArray<ContributorGroup> {
  const groups = new Map<string | null, { count: number; tokens: number }>();
  for (const contributor of contributors) {
    const source = contributor.source ?? null;
    const group = groups.get(source) ?? { count: 0, tokens: 0 };
    group.count += 1;
    group.tokens += contributor.tokens;
    groups.set(source, group);
  }
  return [...groups]
    .map(([source, group]) => ({ source, ...group }))
    .toSorted((left, right) => right.tokens - left.tokens);
}

/** Tokens left before the provider compacts on its own; null when it does not say. */
export function tokensUntilAutoCompact(
  threshold: number | null | undefined,
  usedTokens: number | null | undefined,
): number | null {
  if (typeof threshold !== "number" || threshold <= 0 || typeof usedTokens !== "number") {
    return null;
  }
  return Math.max(0, threshold - usedTokens);
}

export function formatContextPercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(value)}%`;
}

export interface OutputFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  /** False when no change to the file reported its own line counts. */
  readonly hasStats: boolean;
}

export interface ThreadOutputFile extends OutputFile {
  /** The newest run that changed the file, for opening its diff. */
  readonly runId: RunId | null;
}

/** Lines added and removed across the files that reported counts; null when none did. */
export function sumOutputChanges(
  outputs: ReadonlyArray<OutputFile>,
): { readonly additions: number; readonly deletions: number } | null {
  let additions = 0;
  let deletions = 0;
  let counted = false;
  for (const output of outputs) {
    if (!output.hasStats) continue;
    counted = true;
    additions += output.additions;
    deletions += output.deletions;
  }
  return counted ? { additions, deletions } : null;
}

// Not applied yet, or never applied.
const UNAPPLIED_FILE_CHANGE_STATUSES = new Set(["pending", "waiting", "failed", "cancelled"]);

export function selectFileChangeItems(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<FileChangeItem> {
  return turnItems.filter((item): item is FileChangeItem => item.type === "file_change");
}

/**
 * Unique files the thread changed, newest first. Line counts add up across
 * edits; an item that changed several files reports one total, which cannot
 * be split per file, so those files show without counts from it.
 */
export function deriveThreadOutputs(
  items: ReadonlyArray<FileChangeItem>,
): ReadonlyArray<ThreadOutputFile> {
  const byPath = new Map<
    string,
    { path: string; runId: RunId | null; additions: number; deletions: number; hasStats: boolean }
  >();
  // Turn items arrive in conversation order, so walking back meets each file's newest edit first.
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (UNAPPLIED_FILE_CHANGE_STATUSES.has(item.status)) continue;
    const paths = new Set(
      item.changes !== undefined && item.changes.length > 0
        ? item.changes.map((change) => change.path)
        : [item.fileName],
    );
    const counted =
      paths.size === 1 && (item.additions !== undefined || item.deletions !== undefined);
    for (const path of paths) {
      let entry = byPath.get(path);
      if (entry === undefined) {
        entry = { path, runId: item.runId, additions: 0, deletions: 0, hasStats: false };
        byPath.set(path, entry);
      } else if (entry.runId === null) {
        entry.runId = item.runId;
      }
      if (counted) {
        entry.additions += item.additions ?? 0;
        entry.deletions += item.deletions ?? 0;
        entry.hasStats = true;
      }
    }
  }
  return [...byPath.values()];
}
