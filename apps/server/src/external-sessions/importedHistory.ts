/**
 * Whether a thread's runless (imported) history items count as context the
 * orchestrator hands to another provider. Upstream only does this for
 * "v1_import" threads; threads continued from another app (`import:` ids,
 * "native" history) hold the same items, and without them a switch to another
 * agent would start with only the T3 turns. Native resumes stay untouched:
 * `shouldPrepareLegacyImportHandoff` still requires "v1_import". Fork add-on;
 * see docs/internals/external-sessions.md.
 *
 * @module external-sessions/importedHistory
 */
import type { OrchestrationV2AppThread } from "@t3tools/contracts";

export const carriesImportedHistory = (
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
