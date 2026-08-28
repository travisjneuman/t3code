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

const RemoteAppThemeColorSchema = Schema.String.check(Schema.isMaxLength(128));

export const RemoteAppThemeColorsSchema = Schema.Struct({
  canvas: RemoteAppThemeColorSchema,
  sidebar: RemoteAppThemeColorSchema,
  sidebarForeground: RemoteAppThemeColorSchema,
  sidebarMutedForeground: RemoteAppThemeColorSchema,
  sidebarRowHover: RemoteAppThemeColorSchema,
  sidebarRowSelected: RemoteAppThemeColorSchema,
  sidebarBorder: RemoteAppThemeColorSchema,
  surface: RemoteAppThemeColorSchema,
  surfaceRaised: RemoteAppThemeColorSchema,
  surfaceOverlay: RemoteAppThemeColorSchema,
  text: RemoteAppThemeColorSchema,
  textMuted: RemoteAppThemeColorSchema,
  muted: RemoteAppThemeColorSchema,
  mutedForeground: RemoteAppThemeColorSchema,
  placeholder: RemoteAppThemeColorSchema,
  border: RemoteAppThemeColorSchema,
  input: RemoteAppThemeColorSchema,
  focus: RemoteAppThemeColorSchema,
  accent: RemoteAppThemeColorSchema,
  accentForeground: RemoteAppThemeColorSchema,
  secondary: RemoteAppThemeColorSchema,
  secondaryForeground: RemoteAppThemeColorSchema,
  toolbar: RemoteAppThemeColorSchema,
  toolbarForeground: RemoteAppThemeColorSchema,
  toolbarBorder: RemoteAppThemeColorSchema,
  toolbarControl: RemoteAppThemeColorSchema,
  toolbarControlForeground: RemoteAppThemeColorSchema,
  messageSurface: RemoteAppThemeColorSchema,
  messageForeground: RemoteAppThemeColorSchema,
  messageAction: RemoteAppThemeColorSchema,
  messageActionForeground: RemoteAppThemeColorSchema,
  messageActionHover: RemoteAppThemeColorSchema,
  codeBackground: RemoteAppThemeColorSchema,
  codeForeground: RemoteAppThemeColorSchema,
});
export type RemoteAppThemeColors = typeof RemoteAppThemeColorsSchema.Type;

export const RemoteAppThemeSchema = Schema.Struct({
  appearance: Schema.Literals(["light", "dark"]),
  colors: RemoteAppThemeColorsSchema,
});
export type RemoteAppTheme = typeof RemoteAppThemeSchema.Type;

export interface DesktopRemoteAppBridge {
  getState: () => Promise<RemoteAppState>;
  setTheme: (theme: RemoteAppTheme) => Promise<void>;
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
