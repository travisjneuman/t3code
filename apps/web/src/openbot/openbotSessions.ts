/**
 * Client calls for the OpenBot section and composer, plus the helpers that tell an OpenBot
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
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type OpenBotAgentSummary,
  OPENBOT_SESSIONS_WS_METHODS,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ScopedThreadRef,
  type ServerConfig,
  type ThreadId,
} from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { waitForThreadShell } from "../state/entities";

export const OPENBOT_DRIVER = ProviderDriverKind.make("openbot");

export const openbotSessionsList = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:openbot-sessions:list",
  tag: OPENBOT_SESSIONS_WS_METHODS.list,
});

export const openbotSessionsOpen = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:openbot-sessions:open",
  tag: OPENBOT_SESSIONS_WS_METHODS.open,
});

/** The enabled OpenBot provider instances an environment offers. */
export function openbotInstanceIds(
  config: Pick<ServerConfig, "providers"> | null | undefined,
): ReadonlyArray<ProviderInstanceId> {
  return (config?.providers ?? []).flatMap((provider) =>
    provider.driver === OPENBOT_DRIVER && provider.enabled ? [provider.instanceId] : [],
  );
}

const withoutOpenBotCache = new WeakMap<ReadonlyArray<unknown>, ReadonlyArray<unknown>>();

/**
 * The providers Compare agents and scheduled tasks may start work on. Each run there is a thread
 * of its own, and OpenBot keeps one conversation per agent, so it is left out. Stable per input.
 */
export function withoutOpenBot<P extends { readonly driver: ProviderDriverKind }>(
  providers: ReadonlyArray<P>,
): ReadonlyArray<P> {
  if (!providers.some((provider) => provider.driver === OPENBOT_DRIVER)) return providers;
  const cached = withoutOpenBotCache.get(providers) as ReadonlyArray<P> | undefined;
  if (cached !== undefined) return cached;
  const kept = providers.filter((provider) => provider.driver !== OPENBOT_DRIVER);
  withoutOpenBotCache.set(providers, kept);
  return kept;
}

/** The agent an OpenBot composer starts on: the Chief of Staff, else the first T3 can message. */
export function defaultOpenBotAgent(
  agents: ReadonlyArray<OpenBotAgentSummary>,
): OpenBotAgentSummary | undefined {
  const sendable = agents.filter((agent) => agent.sendable && agent.conversationId !== undefined);
  return (
    sendable.find((agent) => agent.title?.trim().toLowerCase() === "chief of staff") ?? sendable[0]
  );
}

/** Opens an agent's main conversation as a T3 thread; its ref, or null after a toast. */
export async function openOpenBotAgentThread(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  conversationId: string,
): Promise<ScopedThreadRef | null> {
  const result = await runOpenBot(
    openbotSessionsOpen,
    environmentId,
    { instanceId, conversationId },
    "Could not open this OpenBot agent",
  );
  if (result === null) return null;
  const threadRef = scopeThreadRef(environmentId, result.threadId);
  if (await waitForThreadShell(threadRef)) return threadRef;
  toastManager.add({
    type: "info",
    title: "Thread created",
    description: "It has not reached this client yet. Open it from the sidebar.",
  });
  return null;
}

/**
 * Sends a new thread's message to the default agent's main conversation, since T3 never starts a
 * second conversation with an OpenBot agent. `start` sends it on the thread it resolves.
 */
export async function sendOpenBotDraft(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  start: (threadId: ThreadId) => Promise<boolean>,
): Promise<ScopedThreadRef | null> {
  const listing = await runOpenBot(
    openbotSessionsList,
    environmentId,
    { instanceId },
    "Could not reach OpenBot",
  );
  if (listing === null) return null;
  const agent = defaultOpenBotAgent(listing.agents ?? []);
  if (agent?.conversationId === undefined) {
    toastManager.add({
      type: "error",
      title: "No OpenBot agent to message",
      description: "Turn on Local scripts for an agent in OpenBot.",
    });
    return null;
  }
  const threadRef = await openOpenBotAgentThread(environmentId, instanceId, agent.conversationId);
  if (threadRef === null || !(await start(threadRef.threadId))) return null;
  return threadRef;
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
