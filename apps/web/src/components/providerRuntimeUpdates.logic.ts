/**
 * Fork add-on(provider-runtime-updates): Antigravity runs a managed runtime that T3 Code
 * downloads itself, so it never gets a CLI version advisory. Settings and Update everything
 * decide here whether that runtime needs installing and how the install finished.
 */
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  PROVIDER_DISPLAY_NAMES,
  resolveProviderInstanceEnabled,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstallState,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

const ACTIVE_PHASES: ReadonlySet<ProviderInstallState["phase"]> = new Set([
  "downloading",
  "extracting",
  "verifying",
]);
export const TERMINAL_INSTALL_PHASES: ReadonlySet<ProviderInstallState["phase"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export function isRuntimeInstallActive(
  install: Pick<ProviderInstallState, "phase"> | null,
): boolean {
  return install !== null && ACTIVE_PHASES.has(install.phase);
}

function customBinaryPath(instance: ProviderInstanceConfig): boolean {
  const config = instance.config;
  if (typeof config !== "object" || config === null) return false;
  const binaryPath = (config as Record<string, unknown>).binaryPath;
  return typeof binaryPath === "string" && binaryPath.trim().length > 0;
}

/** The managed runtime is behind the published one, or missing or unusable on an enabled instance. */
export function runtimeNeedsInstall(found: {
  readonly instance: ProviderInstanceConfig;
  readonly live: ServerProvider | undefined;
  readonly install: Pick<ProviderInstallState, "phase" | "version" | "installedVersion"> | null;
}): boolean {
  const { instance, live, install } = found;
  if (!live?.setup?.canInstall || install === null) return false;
  if (ACTIVE_PHASES.has(install.phase) || customBinaryPath(instance)) return false;
  if (install.installedVersion !== null) {
    return install.version !== null && install.version !== install.installedVersion;
  }
  // A legacy (pre-CLI) or damaged runtime still reads as installed but resolves to no version
  // with a failed phase; installing replaces it.
  return resolveProviderInstanceEnabled(instance) && (!live.installed || install.phase === "failed");
}

export interface RuntimeInstallRun {
  readonly kind: "runtime";
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly result: AtomCommandResult<ProviderInstallState, unknown>;
  /** The install's last reported state, or null when it stopped reporting before finishing. */
  readonly final: ProviderInstallState | null;
}

export function getRuntimeInstallRunOutcome(
  run: RuntimeInstallRun,
  resolve: MessageResolver = m,
):
  | { readonly status: "interrupted" }
  | { readonly status: "updated"; readonly message: string | null }
  | { readonly status: "failed"; readonly line: string } {
  if (isAtomCommandInterrupted(run.result)) return { status: "interrupted" };
  const label = `${run.machineLabel} · ${PROVIDER_DISPLAY_NAMES[run.driver] ?? run.driver}`;
  if (run.result._tag === "Failure") {
    const error = squashAtomCommandFailure(run.result);
    return {
      status: "failed",
      line: `${label}: ${thrownErrorMessage(error, resolve) ?? resolve(msg("Provider update failed."))}`,
    };
  }
  return run.final?.phase === "succeeded"
    ? { status: "updated", message: null }
    : {
        status: "failed",
        line: `${label}: ${run.final?.message ?? resolve(msg("Provider update did not finish."))}`,
      };
}
