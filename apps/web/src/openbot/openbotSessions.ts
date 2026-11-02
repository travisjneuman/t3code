/**
 * Client calls for the OpenBot section, plus the helpers that tell an OpenBot
 * thread from the rest. `runOpenBot` resolves to null on failure. Fork add-on: OpenBot provider.
 *
 * @module openbot/openbotSessions
 */
import {
  type AtomCommand,
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  OPENBOT_SESSIONS_WS_METHODS,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const OPENBOT_DRIVER = ProviderDriverKind.make("openbot");

export const openbotSessionsList = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:openbot-sessions:list",
  tag: OPENBOT_SESSIONS_WS_METHODS.list,
});

export const openbotSessionsOpen = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:openbot-sessions:open",
  tag: OPENBOT_SESSIONS_WS_METHODS.open,
});

export const openbotSessionsNewChat = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:openbot-sessions:new-chat",
  tag: OPENBOT_SESSIONS_WS_METHODS.newChat,
});

/** The enabled OpenBot provider instances an environment offers. */
export function openbotInstanceIds(
  config: Pick<ServerConfig, "providers"> | null | undefined,
): ReadonlyArray<ProviderInstanceId> {
  return (config?.providers ?? []).flatMap((provider) =>
    provider.driver === OPENBOT_DRIVER && provider.enabled ? [provider.instanceId] : [],
  );
}

/** True when the thread runs on an OpenBot instance of its environment. */
export function isOpenBotThread(
  thread: { readonly environmentId: string; readonly providerInstanceId: string },
  providersByEnvironment: ReadonlyMap<
    string,
    ReadonlyMap<string, { readonly driverKind: ProviderDriverKind }>
  >,
): boolean {
  return (
    providersByEnvironment.get(thread.environmentId)?.get(thread.providerInstanceId)?.driverKind ===
    OPENBOT_DRIVER
  );
}

/** Runs an OpenBot command; the value, or null after an error toast titled `failureTitle` unless `quiet`. */
export const runOpenBot = async <Input, A, E>(
  cmd: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: Input }, A, E>,
  environmentId: EnvironmentId,
  input: Input,
  failureTitle: string | null,
): Promise<A | null> => {
  const result = await runAtomCommand(
    appAtomRegistry,
    cmd,
    { environmentId, input },
    { reportFailure: false },
  );
  if (result._tag === "Success") return result.value;
  if (failureTitle !== null && !isAtomCommandInterrupted(result)) {
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: failureTitle,
      description: failure instanceof Error ? failure.message : "An error occurred.",
    });
  }
  return null;
};
