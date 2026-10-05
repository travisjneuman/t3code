import * as Schema from "effect/Schema";

/** Web apps the desktop shell can host in their own isolated, persistent session. */
export const RemoteAppSiteSchema = Schema.Literals([
  "chatgpt",
  "claude",
  "grok",
  "gemini",
  "perplexity",
]);
export type RemoteAppSite = typeof RemoteAppSiteSchema.Type;

export const REMOTE_APP_SITES = RemoteAppSiteSchema.literals;

export interface RemoteAppSiteInfo {
  readonly label: string;
  /**
   * The provider driver whose enabled instance offers the site in the surface
   * menu unless the user hides it. Null marks a standalone site with no T3
   * provider, which the user opts into instead. Either way the site's web
   * session signs in on its own.
   */
  readonly providerDriver: string | null;
}

/**
 * The shared half of each site's registry entry. The desktop half (entry URL,
 * hosts, partition, menu icon, optional theme) lives in apps/desktop/src/remote-apps,
 * and the renderer icon in apps/web/src/remote-apps/RemoteAppSiteIcon.tsx.
 */
export const REMOTE_APP_SITE_INFO: Record<RemoteAppSite, RemoteAppSiteInfo> = {
  chatgpt: { label: "ChatGPT", providerDriver: "codex" },
  claude: { label: "Claude", providerDriver: "claudeAgent" },
  grok: { label: "Grok", providerDriver: "grok" },
  gemini: { label: "Gemini", providerDriver: "antigravity" },
  perplexity: { label: "Perplexity", providerDriver: null },
};

export const isRemoteAppSite = (value: unknown): value is RemoteAppSite =>
  typeof value === "string" && (REMOTE_APP_SITES as ReadonlyArray<string>).includes(value);

export const DesktopSurfaceSchema = Schema.Literals(["t3code", ...REMOTE_APP_SITES]);
export type DesktopSurface = typeof DesktopSurfaceSchema.Type;

export const RemoteAppAvailabilitySchema = Schema.Struct({
  sites: Schema.Array(RemoteAppSiteSchema).check(Schema.isMaxLength(REMOTE_APP_SITES.length)),
  // The available sites the shell loads in the background before their first
  // activation, in preload order. The shell keeps their views while hidden.
  backgroundSites: Schema.Array(RemoteAppSiteSchema).check(
    Schema.isMaxLength(REMOTE_APP_SITES.length),
  ),
  // Minutes a hidden site's view may go unshown before the shell releases it.
  // Null keeps hidden views until the window closes.
  idleUnloadMinutes: Schema.NullOr(
    Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 1_440 })),
  ),
});
export type RemoteAppAvailability = typeof RemoteAppAvailabilitySchema.Type;

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
  // Sites that finished a reply while hidden and haven't been shown since.
  // Optional so state files written before the field existed still decode.
  unreadSites: Schema.optionalKey(
    Schema.Array(RemoteAppSiteSchema).check(Schema.isMaxLength(REMOTE_APP_SITES.length)),
  ),
});
export type RemoteAppState = typeof RemoteAppStateSchema.Type;

/** Longest text the shell moves between a web app and a T3 thread in one send. */
export const REMOTE_APP_TRANSFER_TEXT_MAX_LENGTH = 200_000;

const RemoteAppTransferTextSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(REMOTE_APP_TRANSFER_TEXT_MAX_LENGTH),
);

/** Text selected in a web app that the user sent to the current T3 thread. */
export const RemoteAppSendToThreadSchema = Schema.Struct({
  site: RemoteAppSiteSchema,
  text: RemoteAppTransferTextSchema,
});
export type RemoteAppSendToThread = typeof RemoteAppSendToThreadSchema.Type;

/** T3 text to place in a web app's prompt box. The shell never submits it. */
export const RemoteAppFillPromptRequestSchema = Schema.Struct({
  site: RemoteAppSiteSchema,
  text: RemoteAppTransferTextSchema,
});
export type RemoteAppFillPromptRequest = typeof RemoteAppFillPromptRequestSchema.Type;

/**
 * "filled": the text is in the site's prompt box. "copied": the shell stayed on
 * the site, put the text on the clipboard, and told the user on the page.
 * "input-not-found": the shell is back on T3 and the text is on the clipboard.
 * "unavailable": the site is not open; nothing changed.
 */
export const RemoteAppFillPromptResultSchema = Schema.Literals([
  "filled",
  "copied",
  "input-not-found",
  "unavailable",
]);
export type RemoteAppFillPromptResult = typeof RemoteAppFillPromptResultSchema.Type;

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

/**
 * Resolved colors of T3's glass menus (`dropdown-glass` and `MenuItem`), so the
 * native surface menu window can match them. `glass` is the translucent tint
 * drawn over native vibrancy; `popover` is the opaque fallback.
 */
export const RemoteAppMenuThemeSchema = Schema.Struct({
  glass: RemoteAppThemeColorSchema,
  popover: RemoteAppThemeColorSchema,
  foreground: RemoteAppThemeColorSchema,
  mutedForeground: RemoteAppThemeColorSchema,
  highlight: RemoteAppThemeColorSchema,
  highlightForeground: RemoteAppThemeColorSchema,
  border: RemoteAppThemeColorSchema,
  separator: RemoteAppThemeColorSchema,
});
export type RemoteAppMenuTheme = typeof RemoteAppMenuThemeSchema.Type;

export const RemoteAppThemeSchema = Schema.Struct({
  appearance: Schema.Literals(["light", "dark"]),
  stageArt: RemoteAppStageArtSchema,
  // T3's sidebar width in CSS px; every site's sidebar is pinned to it. Null
  // while T3's sidebar is collapsed, which leaves sites at their own width.
  sidebarWidth: Schema.NullOr(
    Schema.Number.check(Schema.isBetween({ minimum: 160, maximum: 512 })),
  ),
  colors: RemoteAppThemeColorsSchema,
  menu: Schema.optionalKey(RemoteAppMenuThemeSchema),
});
export type RemoteAppTheme = typeof RemoteAppThemeSchema.Type;

export interface DesktopRemoteAppBridge {
  getState: () => Promise<RemoteAppState>;
  setTheme: (theme: RemoteAppTheme) => Promise<void>;
  openSurfaceMenu: (anchor: RemoteAppSurfaceMenuAnchor) => Promise<void>;
  setAvailableSites: (availability: RemoteAppAvailability) => Promise<void>;
  setActiveSurface: (surface: DesktopSurface) => Promise<RemoteAppState>;
  goBack: () => Promise<RemoteAppState>;
  goForward: () => Promise<RemoteAppState>;
  reload: () => Promise<RemoteAppState>;
  zoomIn: () => Promise<RemoteAppState>;
  zoomOut: () => Promise<RemoteAppState>;
  resetZoom: () => Promise<RemoteAppState>;
  retry: () => Promise<RemoteAppState>;
  clearData: () => Promise<RemoteAppState>;
  // Switches to the site and types the text into its prompt box without
  // submitting. Anything but "filled" leaves the text for the caller to copy.
  fillSitePrompt: (request: RemoteAppFillPromptRequest) => Promise<RemoteAppFillPromptResult>;
  onStateChange: (listener: (state: RemoteAppState) => void) => () => void;
  onSendToThread: (listener: (send: RemoteAppSendToThread) => void) => () => void;
}
