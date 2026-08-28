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
