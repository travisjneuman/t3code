/**
 * Reads over a thread projection shared by the Markdown and JSON exports.
 * Fork add-on: thread export.
 *
 * @module thread-export/projectionView
 */
import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  TurnItemId,
} from "@t3tools/contracts";

/** Project fields an export names; null when the project row is gone. */
export interface ExportProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

/**
 * The thread's own items that T3's timeline does not show, such as items of a
 * superseded attempt. They are still persisted, so the export keeps them.
 */
export const hiddenTurnItemIds = (
  projection: OrchestrationV2ThreadProjection,
): ReadonlySet<TurnItemId> => {
  const visible = new Set(
    projection.visibleTurnItems
      .filter((row) => row.visibility === "local")
      .map((row) => row.sourceItemId),
  );
  return new Set(
    projection.turnItems.filter((item) => !visible.has(item.id)).map((item) => item.id),
  );
};

/** Items a fork shows before its own history: the source thread's, plus the fork marker. */
export const inheritedTurnItems = (
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> =>
  projection.visibleTurnItems.filter((row) => row.visibility !== "local");

/** Threads continued from another app or imported from T3's V1 storage carry runless history. */
export const carriesImportedHistory = (projection: OrchestrationV2ThreadProjection): boolean =>
  projection.thread.historyOrigin === "v1_import" || projection.thread.id.startsWith("import:");

const SLUG_MAX = 60;

export const exportFileName = (title: string, extension: "md" | "json"): string => {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return `${slug || "thread"}.${extension}`;
};
