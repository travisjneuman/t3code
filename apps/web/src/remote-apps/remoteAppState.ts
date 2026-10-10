import {
  isRemoteAppSite,
  REMOTE_APP_SITE_INFO,
  REMOTE_APP_SITES,
  type RemoteAppSite,
  type RemoteAppState,
  type ServerProvider,
} from "@t3tools/contracts";

export const DEFAULT_REMOTE_APP_STATE: RemoteAppState = {
  schemaVersion: 1,
  activeSurface: "t3code",
  loadState: "not-created",
  currentUrl: "https://chatgpt.com/",
  currentTitle: "ChatGPT",
  canGoBack: false,
  canGoForward: false,
  recents: [],
  error: null,
};

/** Text sizes offered in Settings and the side panel menu; 1 matches T3. */
export const REMOTE_APP_TEXT_SIZE_CHOICES = [0.8, 0.9, 1, 1.1, 1.2] as const;

export const remoteAppTextSizeLabel = (size: number): string => {
  const percent = Math.round((size - 1) * 100);
  if (percent === 0) return "Match T3";
  return percent > 0 ? `+${percent}%` : `−${-percent}%`;
};

export const isRemoteAppSurface = (value: unknown): value is RemoteAppState["activeSurface"] =>
  value === "t3code" || isRemoteAppSite(value);

/** The site on screen, or undefined while T3 itself is showing. */
export const activeRemoteAppSite = (state: RemoteAppState): RemoteAppSite | undefined =>
  state.activeSurface === "t3code" ? undefined : state.activeSurface;

/** Available sites, other than the one on screen, that finished a reply while hidden. */
export const unreadRemoteAppSites = (
  state: RemoteAppState,
  available: ReadonlyArray<RemoteAppSite>,
): ReadonlyArray<RemoteAppSite> => {
  const unread = state.unreadSites ?? [];
  return unread.length === 0
    ? []
    : available.filter((site) => site !== state.activeSurface && unread.includes(site));
};

type RemoteAppProviders = ReadonlyArray<Pick<ServerProvider, "driver" | "enabled">>;

/** The provider sites whose provider has any enabled instance on this machine's server. */
export const resolveEnabledRemoteAppSites = (
  providers: RemoteAppProviders,
): ReadonlyArray<RemoteAppSite> =>
  REMOTE_APP_SITES.filter((site) => {
    const driver = REMOTE_APP_SITE_INFO[site].providerDriver;
    return (
      driver !== null &&
      providers.some((provider) => provider.driver === driver && provider.enabled)
    );
  });

/**
 * The sites in the surface menu: a provider site while its provider is enabled
 * and the user has not hidden it, and a standalone site once the user turns it on.
 */
export const resolveAvailableRemoteAppSites = (
  providers: RemoteAppProviders,
  hiddenSites: ReadonlyArray<RemoteAppSite>,
  enabledStandaloneSites: ReadonlyArray<RemoteAppSite>,
): ReadonlyArray<RemoteAppSite> => {
  const enabledProviderSites = resolveEnabledRemoteAppSites(providers);
  return REMOTE_APP_SITES.filter((site) =>
    REMOTE_APP_SITE_INFO[site].providerDriver === null
      ? enabledStandaloneSites.includes(site)
      : enabledProviderSites.includes(site) && !hiddenSites.includes(site),
  );
};

export const resolveRemoteAppState = (state: RemoteAppState | null | undefined): RemoteAppState =>
  state ?? DEFAULT_REMOTE_APP_STATE;

/**
 * The native remote view owns everything below the shared titlebar. Keep the
 * host T3 workspace chrome out of that exposed strip while the remote surface
 * is active; otherwise the two toolbars paint on top of each other.
 */
export const shouldHideHostWorkspaceChrome = (input: {
  readonly bridgeAvailable: boolean;
  readonly activeSurface: RemoteAppState["activeSurface"];
}): boolean => input.bridgeAvailable && input.activeSurface !== "t3code";

/**
 * A native surface switch returns the authoritative state immediately, while
 * the matching IPC notification may arrive after an older queued notification.
 * Once the renderer has an initialized snapshot, a notification for the other
 * surface is stale and must not repaint the titlebar back to that surface.
 */
export const shouldAcceptRemoteAppState = (input: {
  readonly current: RemoteAppState;
  readonly next: RemoteAppState;
  readonly initialized: boolean;
}): boolean => !input.initialized || input.current.activeSurface === input.next.activeSurface;
