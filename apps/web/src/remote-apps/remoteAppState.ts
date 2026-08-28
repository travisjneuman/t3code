import type { RemoteAppState } from "@t3tools/contracts";

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
  value === "t3code" || value === "chatgpt";

export const resolveRemoteAppState = (state: RemoteAppState | null | undefined): RemoteAppState =>
  state ?? DEFAULT_REMOTE_APP_STATE;

/**
 * The native ChatGPT view owns everything below the shared titlebar. Keep the
 * host T3 workspace chrome out of that exposed strip while the remote surface
 * is active; otherwise the two toolbars paint on top of each other.
 */
export const shouldHideHostWorkspaceChrome = (input: {
  readonly bridgeAvailable: boolean;
  readonly activeSurface: RemoteAppState["activeSurface"];
}): boolean => input.bridgeAvailable && input.activeSurface === "chatgpt";

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
