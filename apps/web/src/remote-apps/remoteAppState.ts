import {
  isRemoteAppSite,
  REMOTE_APP_SITE_PROVIDER_DRIVERS,
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
  zoomFactor: 1,
  recents: [],
  error: null,
};

export const isRemoteAppSurface = (value: unknown): value is RemoteAppState["activeSurface"] =>
  value === "t3code" || isRemoteAppSite(value);

/** The site on screen, or undefined while T3 itself is showing. */
export const activeRemoteAppSite = (state: RemoteAppState): RemoteAppSite | undefined =>
  state.activeSurface === "t3code" ? undefined : state.activeSurface;

/**
 * A site joins the surface menu once any enabled instance of its provider is
 * signed in on this machine's server.
 */
export const resolveAvailableRemoteAppSites = (
  providers: ReadonlyArray<Pick<ServerProvider, "driver" | "enabled" | "auth">>,
): ReadonlyArray<RemoteAppSite> =>
  REMOTE_APP_SITES.filter((site) =>
    providers.some(
      (provider) =>
        provider.driver === REMOTE_APP_SITE_PROVIDER_DRIVERS[site] &&
        provider.enabled &&
        provider.auth.status === "authenticated",
    ),
  );

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

/**
 * While a site is showing, the host sidebar column (titlebar switcher and
 * footer) follows the site's own sidebar width instead of imposing T3's.
 * Undefined keeps T3's width: T3 itself, or a site whose sidebar is collapsed
 * or not measured yet.
 */
export const resolveRemoteAppSiteSidebarWidth = (state: RemoteAppState): number | undefined =>
  state.activeSurface !== "t3code" && state.siteSidebarWidth ? state.siteSidebarWidth : undefined;
