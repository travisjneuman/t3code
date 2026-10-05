/**
 * Client calls for Compare agents: start a comparison, and send each side the
 * other's answer (review swap). Failures surface as toasts here, so callers
 * only handle success. Fork add-on: compare agents.
 *
 * @module compare-agents/compareAgents
 */
import {
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  COMPARE_AGENTS_WS_METHODS,
  type CompareAgentsStartInput,
  comparePairOf,
  type EnvironmentId,
} from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const startCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:compare-agents:start",
  tag: COMPARE_AGENTS_WS_METHODS.start,
});

const reviewSwapCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:compare-agents:review-swap",
  tag: COMPARE_AGENTS_WS_METHODS.reviewSwap,
});

/** A pair id taken from a URL, or undefined when it is not one. */
export const parsePairId = (value: unknown): string | undefined =>
  typeof value === "string" && comparePairOf(`compare:${value}:a`) !== null ? value : undefined;

const failureToast = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );

/** Starts both threads; resolves to the new pair id, or null after a failure toast. */
export const startComparison = async (
  environmentId: EnvironmentId,
  input: CompareAgentsStartInput,
): Promise<string | null> => {
  const result = await runAtomCommand(
    appAtomRegistry,
    startCommand,
    { environmentId, input },
    { reportFailure: false },
  );
  if (result._tag === "Success") return result.value.pairId;
  if (!isAtomCommandInterrupted(result)) {
    failureToast("Could not start the comparison", squashAtomCommandFailure(result));
  }
  return null;
};

export const reviewSwap = async (environmentId: EnvironmentId, pairId: string): Promise<void> => {
  const result = await runAtomCommand(
    appAtomRegistry,
    reviewSwapCommand,
    { environmentId, input: { pairId } },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    if (!isAtomCommandInterrupted(result)) {
      failureToast("Review swap failed", squashAtomCommandFailure(result));
    }
    return;
  }
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title: "Review swap sent",
      description: "Each agent is now reviewing the other's answer.",
    }),
  );
};
