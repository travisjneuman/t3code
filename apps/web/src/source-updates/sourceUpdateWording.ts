/**
 * Wording for desktop builds that update from a local source checkout
 * (`DesktopUpdateState.sourceUpdate`): "downloading" merges upstream and builds,
 * "installing" replaces the installed app with that build. Upstream's update
 * helpers call these first and keep their own text when they return null.
 * Fork add-on: local source updates.
 *
 * @module source-updates/sourceUpdateWording
 */
import type { DesktopUpdateState } from "@t3tools/contracts";
import { PRODUCT_NAME } from "@t3tools/shared/branding";

import type { DesktopUpdateButtonAction } from "../components/desktopUpdate.logic";

/** Button labels for the download and install actions of a source update. */
export const SOURCE_UPDATE_ACTION_LABELS = {
  download: "Sync & Build",
  install: "Restart & Install",
} as const;

export function getSourceUpdateActionLabel(action: DesktopUpdateButtonAction): string | null {
  return action === "none" ? null : SOURCE_UPDATE_ACTION_LABELS[action];
}

/** The settings description for a pending source update, else `fallback`. */
export function withSourceUpdateDescription(
  state: DesktopUpdateState | null,
  fallback: string,
): string {
  return state?.sourceUpdate
    ? "Merges the latest upstream nightly into this fork and builds the app locally."
    : fallback;
}

export function getSourceUpdateButtonTooltip(state: DesktopUpdateState): string | null {
  if (!state.sourceUpdate) return null;
  if (state.status === "available") {
    return `Upstream nightly${state.availableVersion ? ` ${state.availableVersion}` : ""} available. Click to merge the upstream nightly into this fork and build locally.`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Building local update${progress}`;
  }
  if (state.status === "downloaded") {
    return `Local build ${state.downloadedVersion ?? state.availableVersion ?? "ready"}. Click to restart and replace the installed app.`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `Merging or building ${state.availableVersion} failed. Click to retry.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Local install failed for ${state.downloadedVersion}. Click to retry.`;
    }
  }
  return null;
}

export function getSourceUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string | null {
  if (!("sourceUpdate" in state) || state.sourceUpdate !== true) return null;
  const version = state.downloadedVersion ?? state.availableVersion;
  return `Install the locally built source update${version ? ` ${version}` : ""} and restart ${PRODUCT_NAME}?\n\nAny running tasks will be interrupted. The installed app will be replaced from the local build.`;
}
