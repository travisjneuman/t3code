import { PRODUCT_NAME } from "@t3tools/shared/branding";

export const REMOTE_APP_DISTRIBUTION = {
  baseName: PRODUCT_NAME,
  appId: "dev.neuman.t3code",
  packagedUserDataDirName: "t3code-tjn",
  // The fork replaces the official app, so it keeps the official ~/.t3 server
  // state (database, settings, provider secrets, logs) and the user's threads.
  packagedBaseDirName: ".t3",
  developmentUserDataDirName: "t3code-tjn-dev",
  protocol: "t3code-tjn",
  distribution: "tjn",
  remoteAppEntryUrl: "https://chatgpt.com/",
  // The custom binary must update from releases built with this same
  // distribution identity. Upstream binaries use a different app identity
  // and data boundary, so they are never a valid update source for TJN.
  updateRepository: "travisjneuman/t3code",
  // electron-builder derives its ShipIt cache from the staged package name.
  // Keep the fork isolated from the official Nightly app, which is named
  // t3code and therefore uses t3code-updater.
  packageName: "t3code-tjn",
  autoUpdateEnabled: true,
} as const;

export type RemoteAppDistribution = typeof REMOTE_APP_DISTRIBUTION;
