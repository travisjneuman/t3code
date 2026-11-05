/** Fork add-on; see docs/internals/external-sessions.md. Provider handoffs include `import:` history;
 * native resumes still require "v1_import" in `shouldPrepareLegacyImportHandoff`.
 * @module external-sessions/importedHistory
 */
import type { OrchestrationV2AppThread } from "@t3tools/contracts";

const carriesImportedHistory = (
  thread: Pick<OrchestrationV2AppThread, "id" | "historyOrigin">,
): boolean => thread.historyOrigin === "v1_import" || thread.id.startsWith("import:");

/**
 * `thread.historyOrigin` as the orchestrator's handoff checks should see it: threads that carry
 * imported history read as "v1_import", so `Orchestrator.ts` swaps one operand instead of
 * rewriting each condition.
 */
export const handoffHistoryOrigin = (
  thread: Pick<OrchestrationV2AppThread, "id" | "historyOrigin">,
): OrchestrationV2AppThread["historyOrigin"] =>
  carriesImportedHistory(thread) ? "v1_import" : thread.historyOrigin;
