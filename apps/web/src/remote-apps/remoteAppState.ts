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
