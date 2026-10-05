/**
 * Client calls for Compare agents: start a comparison, send each side the
 * other's answer (review swap), send one follow-up to both, and stop both.
 * Failures surface as toasts here, so callers only handle success.
 * Fork add-on: compare agents.
 *
 * @module compare-agents/compareAgents
 */
import {
  type AtomCommand,
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  COMPARE_AGENTS_WS_METHODS,
  type CompareAgentsFollowUpInput,
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

const followUpCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:compare-agents:follow-up",
  tag: COMPARE_AGENTS_WS_METHODS.followUp,
});

const stopCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:compare-agents:stop",
  tag: COMPARE_AGENTS_WS_METHODS.stop,
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

/** Runs a pair command; true on success, false after a failure toast. */
const runPairCommand = async <Input, A, E>(
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: Input }, A, E>,
  environmentId: EnvironmentId,
  input: Input,
  failureTitle: string,
): Promise<boolean> => {
  const result = await runAtomCommand(
    appAtomRegistry,
    command,
    { environmentId, input },
    { reportFailure: false },
  );
  if (result._tag === "Success") return true;
  if (!isAtomCommandInterrupted(result)) {
    failureToast(failureTitle, squashAtomCommandFailure(result));
  }
  return false;
};

export const reviewSwap = (environmentId: EnvironmentId, pairId: string): Promise<boolean> =>
  runPairCommand(reviewSwapCommand, environmentId, { pairId }, "Review swap failed");

export const sendFollowUp = (
  environmentId: EnvironmentId,
  input: CompareAgentsFollowUpInput,
): Promise<boolean> =>
  runPairCommand(followUpCommand, environmentId, input, "Could not send the follow-up");

export const stopComparison = (environmentId: EnvironmentId, pairId: string): Promise<boolean> =>
  runPairCommand(stopCommand, environmentId, { pairId }, "Could not stop the agents");
