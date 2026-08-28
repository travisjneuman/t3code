export const REMOTE_APP_DISTRIBUTION = {
  baseName: "T3 Code TJN",
  appId: "dev.neuman.t3code",
  packagedUserDataDirName: "t3code-tjn",
  // Keep the fork's packaged server state away from the upstream desktop
  // app's default ~/.t3 directory. This includes the SQLite database,
  // server settings, provider secrets, and backend logs.
  packagedBaseDirName: ".t3-tjn",
  developmentUserDataDirName: "t3code-tjn-dev",
  protocol: "t3code-tjn",
  distribution: "tjn",
  remoteAppEntryUrl: "https://chatgpt.com/",
  // The custom binary must update from releases built with this same
  // distribution identity. Upstream binaries use a different app identity
  // and data boundary, so they are never a valid update source for TJN.
  updateRepository: "travisjneuman/t3code",
  autoUpdateEnabled: true,
} as const;

export type RemoteAppDistribution = typeof REMOTE_APP_DISTRIBUTION;
