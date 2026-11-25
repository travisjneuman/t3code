/** Fork add-on(provider-runtime-updates): managed runtime state and installs; see the .logic file. */
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstallState,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentAtomList } from "~/state/environmentAtomList";
import { serverEnvironment } from "~/state/server";
import {
  runtimeNeedsInstall,
  TERMINAL_INSTALL_PHASES,
  type RuntimeInstallRun,
} from "./providerRuntimeUpdates.logic";

// A runtime download is a few hundred MB; past this the run reports it unfinished, not hung.
const RUNTIME_INSTALL_TIMEOUT_MS = 15 * 60_000;

export function providerInstallStateAtom(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
) {
  return serverEnvironment.providerInstallState({ environmentId, input: { instanceId } });
}

// Watching install state also runs the server's throttled latest-release lookup, so only
// enabled managed instances are watched. Joined ids keep unchanged pushes from re-rendering.
const environmentRuntimeInstallsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): string => {
    const settings = get(serverEnvironment.settingsValueAtom(environmentId));
    const providers = get(serverEnvironment.providersValueAtom(environmentId));
    if (!settings || !providers) return "";
    return providers
      .filter(
        (live) =>
          live.driver === "antigravity" && live.enabled && live.setup?.canInstall === true,
      )
      .filter((live) =>
        runtimeNeedsInstall({
          instance: settings.providerInstances?.[live.instanceId] ?? { driver: live.driver },
          live,
          install: AsyncResult.getOrElse(
            get(providerInstallStateAtom(environmentId, live.instanceId)),
            () => null,
          ),
        }),
      )
      .map((live) => live.instanceId)
      .join("\n");
  }).pipe(Atom.withLabel(`web-provider-runtime-installs:${environmentId}`)),
);

/** Per environment, newline-joined instance ids whose managed runtime needs installing. */
export const providerRuntimeInstallsAtom = environmentAtomList(
  "web-provider-runtime-installs",
  environmentRuntimeInstallsAtom,
);

function waitForRuntimeInstall(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  operationId: string,
): Promise<ProviderInstallState | null> {
  return new Promise((resolve) => {
    let done = false;
    let stop: (() => void) | null = null;
    const finish = (state: ProviderInstallState | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop?.();
      resolve(state);
    };
    const timer = setTimeout(() => finish(null), RUNTIME_INSTALL_TIMEOUT_MS);
    const unsubscribe = appAtomRegistry.subscribe(
      providerInstallStateAtom(environmentId, instanceId),
      (result) => {
        const state = AsyncResult.getOrElse(result, () => null);
        if (state?.operationId === operationId && TERMINAL_INSTALL_PHASES.has(state.phase)) {
          finish(state);
        }
      },
      { immediate: true },
    );
    if (done) unsubscribe();
    else stop = unsubscribe;
  });
}

type StartInstall = (args: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly instanceId: ProviderInstanceId };
}) => Promise<AtomCommandResult<ProviderInstallState, unknown>>;

/** Starts the install and resolves once it finishes, so a server restart cannot cut it off. */
export async function runRuntimeInstall(
  startInstall: StartInstall,
  target: {
    readonly environmentId: EnvironmentId;
    readonly machineLabel: string;
    readonly driver: ProviderDriverKind;
    readonly instanceId: ProviderInstanceId;
  },
): Promise<RuntimeInstallRun> {
  const result = await startInstall({
    environmentId: target.environmentId,
    input: { instanceId: target.instanceId },
  });
  const started = result._tag === "Success" ? result.value : null;
  const final =
    started === null || TERMINAL_INSTALL_PHASES.has(started.phase) || started.operationId === null
      ? started
      : await waitForRuntimeInstall(target.environmentId, target.instanceId, started.operationId);
  return { kind: "runtime", ...target, result, final };
}
