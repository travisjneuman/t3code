import { PRODUCT_NAME } from "@t3tools/shared/branding";

// The fork's whole identity. Upstream files reach it through one-line
// `Fork add-on` hooks; everything else stays upstream's. Server state stays in
// ~/.t3 like upstream, so the fork keeps the user's threads and settings.
export const REMOTE_APP_DISTRIBUTION = {
  baseName: PRODUCT_NAME,
  appId: "dev.neuman.t3code",
  // The fork keeps its own Electron profile so it never opens the official
  // app's Chromium databases or remote-app sessions.
  packagedUserDataDirName: "t3code-tjn",
  developmentUserDataDirName: "t3code-tjn-dev",
  protocol: "t3code-tjn",
  remoteAppEntryUrl: "https://chatgpt.com/",
  // electron-builder derives its ShipIt cache from the staged package name.
  // Keep the fork isolated from the official Nightly app, which is named
  // t3code and therefore uses t3code-updater.
  packageName: "t3code-tjn",
} as const;

export type RemoteAppDistribution = typeof REMOTE_APP_DISTRIBUTION;

/** The fork's link scheme, which also names its Linux desktop entry and window class. */
export const forkAppScheme = (isDevelopment: boolean): string =>
  isDevelopment ? `${REMOTE_APP_DISTRIBUTION.protocol}-dev` : REMOTE_APP_DISTRIBUTION.protocol;

/** Electron userData directory names; never the official app's, so the fork never opens its profile. */
export const forkUserDataDirNames = (
  isDevelopment: boolean,
): { readonly current: string; readonly legacy: string } => {
  const current = isDevelopment
    ? REMOTE_APP_DISTRIBUTION.developmentUserDataDirName
    : REMOTE_APP_DISTRIBUTION.packagedUserDataDirName;
  return { current, legacy: `${current}-legacy` };
};
