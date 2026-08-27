export const REMOTE_APP_DISTRIBUTION = {
  baseName: "T3 Code TJN",
  appId: "dev.neuman.t3code",
  packagedUserDataDirName: "t3code-tjn",
  developmentUserDataDirName: "t3code-tjn-dev",
  protocol: "t3code-tjn",
  distribution: "tjn",
  remoteAppEntryUrl: "https://chatgpt.com/",
  autoUpdateEnabled: false,
} as const;

export type RemoteAppDistribution = typeof REMOTE_APP_DISTRIBUTION;
