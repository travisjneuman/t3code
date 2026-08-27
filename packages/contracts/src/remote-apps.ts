import * as Schema from "effect/Schema";

export const DesktopSurfaceSchema = Schema.Literals(["t3code", "chatgpt"]);
export type DesktopSurface = typeof DesktopSurfaceSchema.Type;

export const RemoteAppLoadStateSchema = Schema.Literals([
  "not-created",
  "creating",
  "loading",
  "ready",
  "failed",
  "crashed",
  "blocked",
  "recovering",
  "clearing",
]);
export type RemoteAppLoadState = typeof RemoteAppLoadStateSchema.Type;

export const RemoteAppErrorCategorySchema = Schema.Literals([
  "navigation",
  "network",
  "renderer",
  "permission",
  "storage",
  "policy",
]);
export type RemoteAppErrorCategory = typeof RemoteAppErrorCategorySchema.Type;

export const RemoteAppErrorCodeSchema = Schema.String.check(Schema.isMaxLength(80));

export const RemoteAppErrorSchema = Schema.Struct({
  category: RemoteAppErrorCategorySchema,
  code: RemoteAppErrorCodeSchema,
});
export type RemoteAppError = typeof RemoteAppErrorSchema.Type;

export const RemoteAppRecentLocationSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2_048)),
  title: Schema.String.check(Schema.isMaxLength(512)),
});
export type RemoteAppRecentLocation = typeof RemoteAppRecentLocationSchema.Type;

export const RemoteAppStateSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  activeSurface: DesktopSurfaceSchema,
  loadState: RemoteAppLoadStateSchema,
  currentUrl: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_048))),
  currentTitle: Schema.String.check(Schema.isMaxLength(512)),
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  zoomFactor: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 3 })),
  recents: Schema.Array(RemoteAppRecentLocationSchema).check(Schema.isMaxLength(20)),
  error: Schema.NullOr(RemoteAppErrorSchema),
});
export type RemoteAppState = typeof RemoteAppStateSchema.Type;

export interface DesktopRemoteAppBridge {
  getState: () => Promise<RemoteAppState>;
  setActiveSurface: (surface: DesktopSurface) => Promise<RemoteAppState>;
  goBack: () => Promise<RemoteAppState>;
  goForward: () => Promise<RemoteAppState>;
  reload: () => Promise<RemoteAppState>;
  zoomIn: () => Promise<RemoteAppState>;
  zoomOut: () => Promise<RemoteAppState>;
  resetZoom: () => Promise<RemoteAppState>;
  retry: () => Promise<RemoteAppState>;
  clearData: () => Promise<RemoteAppState>;
  onStateChange: (listener: (state: RemoteAppState) => void) => () => void;
}
