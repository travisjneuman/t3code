/**
 * Client calls for the Hermes Agent section and settings, plus the helpers
 * that tell a Hermes thread from the rest. `runHermes` reports a failure as
 * a toast and resolves to null. Fork add-on: Hermes provider.
 *
 * @module hermes/hermesSessions
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
  HERMES_SESSIONS_WS_METHODS,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerConfig,
  type ServerSettings,
} from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const HERMES_DRIVER = ProviderDriverKind.make("hermes");

export const hermesSessionsList = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hermes-sessions:list",
  tag: HERMES_SESSIONS_WS_METHODS.list,
});

export const hermesSessionsProviders = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hermes-sessions:providers",
  tag: HERMES_SESSIONS_WS_METHODS.providers,
});

export const hermesSessionsContinue = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hermes-sessions:continue",
  tag: HERMES_SESSIONS_WS_METHODS.continue,
});

export const hermesSessionsUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hermes-sessions:update",
  tag: HERMES_SESSIONS_WS_METHODS.update,
});

export const hermesSessionsDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hermes-sessions:delete",
  tag: HERMES_SESSIONS_WS_METHODS.delete,
});

export const hermesSessionsListArchived = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hermes-sessions:listArchived",
  tag: HERMES_SESSIONS_WS_METHODS.listArchived,
});

export const hermesSessionsUnarchive = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hermes-sessions:unarchive",
  tag: HERMES_SESSIONS_WS_METHODS.unarchive,
});

export const hermesDashboard = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hermes-sessions:dashboard",
  tag: HERMES_SESSIONS_WS_METHODS.dashboard,
});

/** Runs a Hermes command; the value, or null after an error toast titled `failureTitle`. */
export const runHermes = async <Input, A, E>(
  cmd: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: Input }, A, E>,
  environmentId: EnvironmentId,
  input: Input,
  failureTitle: string,
): Promise<A | null> => {
  const result = await runAtomCommand(
    appAtomRegistry,
    cmd,
    { environmentId, input },
    { reportFailure: false },
  );
  if (result._tag === "Success") return result.value;
  if (!isAtomCommandInterrupted(result)) {
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: failureTitle,
      description: failure instanceof Error ? failure.message : "An error occurred.",
    });
  }
  return null;
};

/** Runs a Hermes command in the background; the value, or null on any failure. */
export const runHermesQuietly = async <Input, A, E>(
  cmd: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: Input }, A, E>,
  environmentId: EnvironmentId,
  input: Input,
): Promise<A | null> => {
  const result = await runAtomCommand(
    appAtomRegistry,
    cmd,
    { environmentId, input },
    { reportFailure: false },
  );
  return result._tag === "Success" ? result.value : null;
};

/** The enabled Hermes provider instances an environment offers. */
export function hermesInstanceIds(
  config: Pick<ServerConfig, "providers"> | null | undefined,
): ReadonlyArray<ProviderInstanceId> {
  return (config?.providers ?? []).flatMap((provider) =>
    provider.driver === HERMES_DRIVER && provider.enabled ? [provider.instanceId] : [],
  );
}

/** The instance's "Agent name" setting, or "Hermes" when it is blank. */
export function hermesAgentName(
  settings: Pick<ServerSettings, "providerInstances"> | null | undefined,
  instanceId: ProviderInstanceId,
): string {
  const instanceConfig = settings?.providerInstances[instanceId]?.config;
  const name =
    typeof instanceConfig === "object" && instanceConfig !== null && "agentName" in instanceConfig
      ? instanceConfig.agentName
      : undefined;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : "Hermes";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The machine the instance's Hermes runs on, from its API URL: the host's
 * first label ("tjn-serve" for `http://tjn-serve.tailnet.ts.net:8642`), an IP
 * as is, or "the T3 host" for a loopback URL.
 */
export function hermesMachineName(
  settings: Pick<ServerSettings, "providerInstances"> | null | undefined,
  instanceId: ProviderInstanceId,
): string {
  const instanceConfig = settings?.providerInstances[instanceId]?.config;
  const apiUrl =
    typeof instanceConfig === "object" && instanceConfig !== null && "apiUrl" in instanceConfig
      ? instanceConfig.apiUrl
      : undefined;
  let host = "";
  try {
    host = typeof apiUrl === "string" ? new URL(apiUrl).hostname : "";
  } catch {
    host = "";
  }
  if (!host) return "its Hermes server";
  if (LOOPBACK_HOSTS.has(host)) return "the T3 host";
  return /^[\d.]+$/.test(host) || host.includes(":") ? host : (host.split(".")[0] ?? host);
}

/** The provider part of a Hermes model slug (`provider::model`), or null for "Hermes default". */
export function hermesModelProvider(model: string): string | null {
  const separator = model.indexOf("::");
  return separator > 0 ? model.slice(0, separator) : null;
}

/** True when the thread runs on a Hermes instance of its environment. */
export function isHermesThread(
  thread: { readonly environmentId: string; readonly providerInstanceId: string },
  configs: ReadonlyMap<string, Pick<ServerConfig, "providers"> | null | undefined>,
): boolean {
  return (configs.get(thread.environmentId)?.providers ?? []).some(
    (provider) =>
      provider.driver === HERMES_DRIVER && provider.instanceId === thread.providerInstanceId,
  );
}
