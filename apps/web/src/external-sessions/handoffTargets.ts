import {
  externalSessionHandoffUnsupportedReason,
  type ExternalSessionContinueInput,
  type ExternalSessionSummary,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  isProviderInstancePickerReady,
  type ProviderInstanceEntry,
} from "../providerInstances";

const NO_HANDOFF_TARGETS: ReadonlyArray<HandoffTarget> = [];

export type HandoffTo = NonNullable<ExternalSessionContinueInput["handoffTo"]>;

/** An enabled agent other than the session's, with the model a handoff starts on. */
export interface HandoffTarget {
  readonly entry: ProviderInstanceEntry;
  readonly model: string;
}

/**
 * Agents the session's history can be handed to: ready instances of every
 * other driver, each on its own default model. Empty when the session's
 * transcript cannot be read for a handoff.
 */
export function resolveHandoffTargets(
  providers: ReadonlyArray<ServerProvider>,
  summary: Pick<ExternalSessionSummary, "driver" | "cwd"> | null,
): ReadonlyArray<HandoffTarget> {
  if (summary === null || externalSessionHandoffUnsupportedReason(summary) !== null) {
    return NO_HANDOFF_TARGETS;
  }
  const targets: Array<HandoffTarget> = [];
  for (const entry of deriveProviderInstanceEntries(providers)) {
    if (!isProviderInstancePickerReady(entry) || entry.driverKind === summary.driver) continue;
    const model = getDefaultProviderInstanceModel(providers, entry.instanceId);
    if (model !== undefined && model.trim().length > 0) targets.push({ entry, model });
  }
  return targets.length === 0 ? NO_HANDOFF_TARGETS : targets;
}
