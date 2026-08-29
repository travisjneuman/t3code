import * as Schema from "effect/Schema";

export const DesktopSurfaceSchema = Schema.Literals(["t3code", "chatgpt"]);
export type DesktopSurface = typeof DesktopSurfaceSchema.Type;

export const RemoteAppSurfaceMenuAnchorSchema = Schema.Struct({
  x: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 20_000 })),
  y: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 20_000 })),
  width: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 2_000 })),
  height: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 2_000 })),
});
export type RemoteAppSurfaceMenuAnchor = typeof RemoteAppSurfaceMenuAnchorSchema.Type;

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

const REMOTE_APP_THEME_COLOR_MAX_LENGTH = 128;
// Browser-serialized stage artwork pigments can contain nested color-mix()
// expressions, so they need a larger bound than ordinary palette tokens.
export const REMOTE_APP_THEME_STAGE_COLOR_MAX_LENGTH = 512;
const RemoteAppThemeColorSchema = Schema.String.check(
  Schema.isMaxLength(REMOTE_APP_THEME_COLOR_MAX_LENGTH),
);
const RemoteAppThemeStageColorSchema = Schema.String.check(
  Schema.isMaxLength(REMOTE_APP_THEME_STAGE_COLOR_MAX_LENGTH),
);

export const RemoteAppStageArtSchema = Schema.Literals(["none", "nightly", "dev"]);
export type RemoteAppStageArt = typeof RemoteAppStageArtSchema.Type;

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
  toolbarControlHover: RemoteAppThemeColorSchema,
  messageSurface: RemoteAppThemeColorSchema,
  messageForeground: RemoteAppThemeColorSchema,
  messageAction: RemoteAppThemeColorSchema,
  messageActionForeground: RemoteAppThemeColorSchema,
  messageActionHover: RemoteAppThemeColorSchema,
  codeBackground: RemoteAppThemeColorSchema,
  codeForeground: RemoteAppThemeColorSchema,
  stageArtTop: RemoteAppThemeStageColorSchema,
  stageArtMid: RemoteAppThemeStageColorSchema,
  stageArtBottom: RemoteAppThemeStageColorSchema,
  stageArtHighlight: RemoteAppThemeStageColorSchema,
  stageArtSecondary: RemoteAppThemeStageColorSchema,
  stageArtTertiary: RemoteAppThemeStageColorSchema,
  stageArtLine: RemoteAppThemeStageColorSchema,
  stageArtCelesteHighlight: RemoteAppThemeStageColorSchema,
  stageArtCelesteSecondary: RemoteAppThemeStageColorSchema,
  stageArtVioletHighlight: RemoteAppThemeStageColorSchema,
  stageArtGridLine: RemoteAppThemeStageColorSchema,
  stageNightTop: RemoteAppThemeStageColorSchema,
  stageNightMid: RemoteAppThemeStageColorSchema,
  stageNightBottom: RemoteAppThemeStageColorSchema,
  stageNightHighlight: RemoteAppThemeStageColorSchema,
  stageNightSecondary: RemoteAppThemeStageColorSchema,
  stageNightTertiary: RemoteAppThemeStageColorSchema,
  stageNightLine: RemoteAppThemeStageColorSchema,
  stageNightGlowHighlight: RemoteAppThemeStageColorSchema,
  stageNightGlowSecondary: RemoteAppThemeStageColorSchema,
  stageNightSparkle: RemoteAppThemeStageColorSchema,
});
export type RemoteAppThemeColors = typeof RemoteAppThemeColorsSchema.Type;

export const RemoteAppThemeSchema = Schema.Struct({
  appearance: Schema.Literals(["light", "dark"]),
  stageArt: RemoteAppStageArtSchema,
  sidebarWidth: Schema.NullOr(
    Schema.Number.check(Schema.isBetween({ minimum: 160, maximum: 512 })),
  ),
  colors: RemoteAppThemeColorsSchema,
});
export type RemoteAppTheme = typeof RemoteAppThemeSchema.Type;

export interface DesktopRemoteAppBridge {
  getState: () => Promise<RemoteAppState>;
  setTheme: (theme: RemoteAppTheme) => Promise<void>;
  openSurfaceMenu: (anchor: RemoteAppSurfaceMenuAnchor) => Promise<void>;
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
