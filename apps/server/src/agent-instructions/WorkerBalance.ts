/** Picks worker models by each subscription's weekly pace, and refuses ones at a usage stop.
 * Fork add-on: agent instructions; see docs/user/agent-instructions.md.
 */
import {
  type AgentSettings,
  isProviderAvailable,
  type ModelSelection,
  type OrchestratorMcpTarget,
  OrchestratorMcpFailure,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { elapsedShare, exhaustedUsageWindow, remainingPercent } from "@t3tools/shared/usageLimits";

import { windowLimitsModel } from "../provider/claudeUsageLimits.ts";

/** Older readings say nothing about pace; stops still apply until their window resets. */
const STALE_AFTER_MS = 30 * 60 * 1000;
const SESSION_STOP_USED_PERCENT = 90;
/** Another model must beat the role's target by this many points to take the worker. */
const TIE_BAND_POINTS = 10;

interface Standing {
  readonly selection: ModelSelection;
  /** Why the model takes no workers right now. */
  readonly stop: string | null;
  /** Weekly percent left minus percent of the week left, on its tightest weekly window. */
  readonly spare: number | null;
}

const label = (selection: Pick<ModelSelection, "instanceId" | "model">) =>
  `${selection.instanceId}/${selection.model}`;

const points = (spare: number) =>
  `${spare >= 0 ? "+" : ""}${Math.round(spare)} points against weekly pace`;

function liveWindows(
  provider: ServerProvider,
  model: string | null,
  now: number,
): ReadonlyArray<ServerProviderUsageWindow> {
  return (provider.usageLimits?.windows ?? []).filter(
    (window) =>
      windowLimitsModel(window, model) &&
      (model === null || window.modelIds === undefined || window.modelIds.includes(model)) &&
      !(window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now),
  );
}

function weeklySpare(windows: ReadonlyArray<ServerProviderUsageWindow>, now: number) {
  let spare: number | null = null;
  for (const window of windows) {
    if (window.kind !== "weekly") continue;
    const elapsed = elapsedShare(window, now);
    if (elapsed === null) continue;
    const value = remainingPercent(window) - (1 - elapsed) * 100;
    spare = spare === null ? value : Math.min(spare, value);
  }
  return spare;
}

function weeklyRemaining(windows: ReadonlyArray<ServerProviderUsageWindow>): number | null {
  const weekly = windows.filter((window) => window.kind === "weekly").map(remainingPercent);
  return weekly.length === 0 ? null : Math.min(...weekly);
}

interface Context {
  readonly settings: Pick<AgentSettings, "agentWorkerBalanceModels" | "agentMainReservePercent">;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly now: number;
  /** The thread's agent: its subscription keeps the reserve. */
  readonly mainInstanceId: ProviderInstanceId;
}

function standing(context: Context, selection: ModelSelection): Standing {
  const provider = context.providers.find((entry) => entry.instanceId === selection.instanceId);
  if (provider === undefined || !provider.enabled || !isProviderAvailable(provider)) {
    return { selection, stop: "not available", spare: null };
  }
  const windows = liveWindows(provider, selection.model, context.now);
  const limits = provider.usageLimits;
  const exhausted =
    limits === undefined
      ? undefined
      : exhaustedUsageWindow(
          { ...provider, usageLimits: { ...limits, windows: [...windows] } },
          context.now,
          selection.model,
        );
  if (exhausted !== undefined) {
    return { selection, stop: `${exhausted.label} limit reached`, spare: null };
  }
  const session = windows.find(
    (window) => window.kind === "session" && window.usedPercent >= SESSION_STOP_USED_PERCENT,
  );
  if (session !== undefined) {
    return {
      selection,
      stop: `${session.label} ${Math.round(session.usedPercent)}% used`,
      spare: null,
    };
  }
  const reserve = context.settings.agentMainReservePercent;
  const remaining = weeklyRemaining(windows);
  if (
    reserve > 0 &&
    selection.instanceId === context.mainInstanceId &&
    remaining !== null &&
    remaining <= reserve
  ) {
    return {
      selection,
      stop: `your own subscription has ${remaining}% of its week left (reserve ${reserve}%)`,
      spare: null,
    };
  }
  const checkedAt = limits === undefined ? Number.NaN : Date.parse(limits.checkedAt);
  const fresh = Number.isFinite(checkedAt) && context.now - checkedAt <= STALE_AFTER_MS;
  return { selection, stop: null, spare: fresh ? weeklySpare(windows, context.now) : null };
}

function sameModel(left: ModelSelection, right: ModelSelection): boolean {
  return left.instanceId === right.instanceId && left.model === right.model;
}

function standings(context: Context, usual: ModelSelection): ReadonlyArray<Standing> {
  const candidates = [usual];
  for (const selection of context.settings.agentWorkerBalanceModels) {
    if (!candidates.some((candidate) => sameModel(candidate, selection))) {
      candidates.push(selection);
    }
  }
  return candidates.map((selection) => standing(context, selection));
}

function mostRoom(open: ReadonlyArray<Standing>): Standing | undefined {
  let best: (Standing & { readonly spare: number }) | undefined;
  for (const entry of open) {
    if (entry.spare !== null && (best === undefined || entry.spare > best.spare)) {
      best = { ...entry, spare: entry.spare };
    }
  }
  return best;
}

const noRoomFailure = (all: ReadonlyArray<Standing>) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `No worker model has room (${all.map((entry) => `${label(entry.selection)}: ${entry.stop}`).join("; ")}). Do this task yourself.`,
  });

export interface Balanced {
  /** The model to run, or undefined to keep the role's usual target. */
  readonly selection: ModelSelection | undefined;
  readonly routing: string;
}

/** The worker model for a delegation that left target out. `usual` is the role's target. */
export function balanceWorker(
  context: Context,
  usual: ModelSelection,
): Balanced | OrchestratorMcpFailure {
  const all = standings(context, usual);
  const usualStanding = all[0]!;
  const open = all.filter((entry) => entry.stop === null);
  if (open.length === 0) return noRoomFailure(all);
  const best = mostRoom(open);
  if (usualStanding.stop !== null) {
    const chosen = best ?? open[0]!;
    return {
      selection: chosen.selection,
      routing: `${label(chosen.selection)} instead of ${label(usual)}: ${usualStanding.stop}.`,
    };
  }
  if (usualStanding.spare === null) {
    return {
      selection: undefined,
      routing: `${label(usual)}, the role's target: no fresh usage reading to balance on.`,
    };
  }
  if (
    best === undefined ||
    best === usualStanding ||
    best.spare === null ||
    best.spare - usualStanding.spare < TIE_BAND_POINTS
  ) {
    return {
      selection: undefined,
      routing: `${label(usual)}, the role's target (${points(usualStanding.spare)}).`,
    };
  }
  return {
    selection: best.selection,
    routing: `${label(best.selection)} (${points(best.spare)}) over ${label(usual)} (${points(usualStanding.spare)}).`,
  };
}

/**
 * Refuses an explicit target at a usage stop, naming a model with room.
 * A target whose provider can't be told is left to target resolution.
 */
export function checkExplicitTarget(
  context: Context,
  requested: OrchestratorMcpTarget,
  fallbackInstanceId: ProviderInstanceId,
): OrchestratorMcpFailure | undefined {
  const instanceId =
    requested.providerInstanceId ??
    (requested.driverKind === undefined
      ? fallbackInstanceId
      : context.providers.find((provider) => provider.driver === requested.driverKind)
          ?.instanceId);
  if (instanceId === undefined) return undefined;
  const model =
    requested.model ??
    context.settings.agentWorkerBalanceModels.find((entry) => entry.instanceId === instanceId)
      ?.model;
  if (model === undefined) return undefined;
  const target = standing(context, { instanceId, model });
  if (target.stop === null) return undefined;
  const others = context.settings.agentWorkerBalanceModels
    .filter((selection) => !sameModel(selection, target.selection))
    .map((selection) => standing(context, selection))
    .filter((entry) => entry.stop === null);
  const alternative = mostRoom(others) ?? others[0];
  return new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `${label(target.selection)} takes no workers now: ${target.stop}. ${
      alternative === undefined
        ? "No balance model has room; do this task yourself."
        : `Leave target out, or use ${label(alternative.selection)}.`
    }`,
  });
}

/** One line for orchestrator_capabilities: weekly room and session use, when the provider reports them. */
export function usageHeadroom(provider: ServerProvider, now: number): string | undefined {
  const windows = liveWindows(provider, null, now);
  const remaining = weeklyRemaining(windows);
  if (remaining === null) return undefined;
  const spare = weeklySpare(windows, now);
  const session = windows.find((window) => window.kind === "session");
  const weekly = `Weekly ${remaining}% left${spare === null ? "" : ` (${points(spare)})`}`;
  return session === undefined
    ? weekly
    : `${weekly}; session ${Math.round(session.usedPercent)}% used`;
}
