import type { RemoteAppSite, RemoteAppTheme, RemoteAppThemeColors } from "@t3tools/contracts";

import { buildRemoteAppThemeCss, normalizeRemoteAppTheme } from "./RemoteAppTheme.ts";

type Rgba = { readonly r: number; readonly g: number; readonly b: number; readonly a: number };

const HEX_COLOR = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;

const parseHex = (value: string): Rgba | null => {
  const match = HEX_COLOR.exec(value.trim());
  if (match === null) return null;
  const rgb = Number.parseInt(match[1]!, 16);
  return {
    r: (rgb >> 16) & 0xff,
    g: (rgb >> 8) & 0xff,
    b: rgb & 0xff,
    a: match[2] === undefined ? 1 : Number.parseInt(match[2], 16) / 255,
  };
};

const mix = (from: Rgba, to: Rgba, amount: number): Rgba => ({
  r: from.r + (to.r - from.r) * amount,
  g: from.g + (to.g - from.g) * amount,
  b: from.b + (to.b - from.b) * amount,
  a: 1,
});

const toHex = ({ r, g, b }: Rgba): string =>
  `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;

/** Space-separated `h s% l%`, the triplet form Claude and Grok wrap in `hsl()`. */
const toHslTriplet = ({ r, g, b }: Rgba): string => {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return `0 0% ${(lightness * 100).toFixed(1)}%`;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue =
    max === red
      ? ((green - blue) / delta + (green < blue ? 6 : 0)) * 60
      : max === green
        ? ((blue - red) / delta + 2) * 60
        : ((red - green) / delta + 4) * 60;
  return `${hue.toFixed(1)} ${(saturation * 100).toFixed(1)}% ${(lightness * 100).toFixed(1)}%`;
};

/**
 * The theme roles as opaque colors. Translucent roles (T3 borders are white at
 * a few percent) are flattened onto the canvas, because the sites mix their own
 * opacity into these tokens.
 */
const resolvePalette = (colors: RemoteAppThemeColors) => {
  const canvas = parseHex(colors.canvas) ?? { r: 10, g: 10, b: 10, a: 1 };
  const solid = (value: string, fallback: Rgba): Rgba => {
    const color = parseHex(value);
    return color === null ? fallback : mix(canvas, { ...color, a: 1 }, color.a);
  };
  const text = solid(colors.text, { r: 245, g: 245, b: 245, a: 1 });
  const textMuted = solid(colors.textMuted, mix(canvas, text, 0.5));
  const surface = solid(colors.surface, mix(canvas, text, 0.03));
  const accent = solid(colors.accent, { r: 52, g: 107, b: 241, a: 1 });
  return {
    canvas,
    text,
    textMuted,
    textSecondary: mix(textMuted, text, 0.45),
    surface,
    surfaceRaised: solid(colors.surfaceRaised, surface),
    surfaceOverlay: solid(colors.surfaceOverlay, surface),
    hover: mix(surface, text, 0.06),
    active: mix(surface, text, 0.1),
    sidebar: solid(colors.sidebar, canvas),
    sidebarText: solid(colors.sidebarForeground, text),
    sidebarSelected: solid(colors.sidebarRowSelected, surface),
    border: solid(colors.border, mix(canvas, text, 0.1)),
    message: solid(colors.messageSurface, surface),
    accent,
    accentHover: solid(colors.messageActionHover, mix(accent, text, 0.12)),
    accentForeground: solid(colors.accentForeground, { r: 255, g: 255, b: 255, a: 1 }),
    accentSurface: mix(canvas, accent, 0.22),
  };
};

type Palette = ReturnType<typeof resolvePalette>;

const declarations = (entries: Record<string, string>): string =>
  Object.entries(entries)
    .map(([name, value]) => `  ${name}: ${value} !important;`)
    .join("\n");

const pageBase = (palette: Palette, colorScheme: string): string => `
html,
body {
  color-scheme: ${colorScheme} !important;
  background-color: ${toHex(palette.canvas)} !important;
  scrollbar-color: ${toHex(palette.active)} transparent !important;
}`;

const buildClaudeCss = (palette: Palette, colorScheme: string): string => {
  const h = toHslTriplet;
  // Claude re-declares its tokens on nested .cds-root wrappers and its frame
  // tokens on .dframe-root/.dframe-sidebar, so the override lands there too.
  return `/* ndev.t3code theme for the isolated Claude surface. */
:root,
body,
.cds-root,
.dframe-root,
.dframe-sidebar,
.dframe-card {
${declarations({
  "--df-bg-page-hsl": h(palette.canvas),
  "--df-bg-page": toHex(palette.canvas),
  "--df-sidebar-bg": toHex(palette.sidebar),
  "--df-hover": toHex(palette.hover),
  "--cds-page-bg": toHex(palette.canvas),
  "--background-color-page": toHex(palette.canvas),
  "--cds-surface-0": toHex(palette.sidebar),
  "--cds-surface-1": toHex(palette.canvas),
  "--cds-surface-2": toHex(palette.surface),
  "--cds-surface-3": toHex(palette.hover),
  "--cds-surface-panel": toHex(palette.surface),
  "--cds-surface-popover": toHex(palette.surfaceOverlay),
  "--cds-neutral-50": toHex(palette.canvas),
  "--cds-text-primary": toHex(palette.text),
  "--cds-text-secondary": toHex(palette.textSecondary),
  "--cds-text-muted": toHex(palette.textMuted),
  "--cds-text-accent": toHex(palette.accent),
  "--cds-fill-accent": toHex(palette.accent),
  "--cds-fill-accent-hover": toHex(palette.accentHover),
  "--cds-role-accent-fill": toHex(palette.accent),
  "--cds-role-accent-fill-hover": toHex(palette.accentHover),
  "--cds-role-accent-on": toHex(palette.accentForeground),
  "--cds-bg-accent": toHex(palette.accentSurface),
  "--cds-bg-accent-chip": toHex(palette.accentSurface),
  "--cds-fill-brand": toHex(palette.accent),
  "--cds-fill-brand-hover": toHex(palette.accentHover),
  "--cds-clay-emphasized": toHex(palette.accent),
  "--cds-on-brand": toHex(palette.accentForeground),
  "--cds-bg-user-message": toHex(palette.message),
  "--cds-role-tooltip-bg": toHex(palette.surfaceOverlay),
  "--cds-role-tooltip-fg": toHex(palette.text),
  "--cds-bg-editor-canvas": toHex(palette.surface),
  "--bg-000": h(palette.surfaceRaised),
  "--bg-100": h(palette.canvas),
  "--bg-200": h(palette.sidebar),
  "--bg-300": h(palette.sidebar),
  "--bg-400": h(palette.sidebar),
  "--bg-500": h(palette.sidebar),
  "--text-000": h(palette.text),
  "--text-100": h(palette.text),
  "--text-200": h(palette.textSecondary),
  "--text-300": h(palette.textSecondary),
  "--text-400": h(palette.textMuted),
  "--text-500": h(palette.textMuted),
  "--accent-000": h(palette.accentHover),
  "--accent-100": h(palette.accent),
  "--accent-200": h(palette.accent),
  "--accent-900": h(palette.accentSurface),
  "--accent-brand": h(palette.accent),
  "--brand-100": h(palette.accent),
  "--oncolor-100": h(palette.accentForeground),
})}
}
${pageBase(palette, colorScheme)}`;
};

const buildGrokCss = (palette: Palette, colorScheme: string): string => {
  const h = toHslTriplet;
  return `/* ndev.t3code theme for the isolated Grok surface. */
:root,
body {
${declarations({
  "--background": toHex(palette.canvas),
  "--background-color": h(palette.canvas),
  "--surface-base": h(palette.canvas),
  "--surface-inset": h(palette.surface),
  "--surface-l1": h(palette.surface),
  "--surface-l1-hover": h(palette.hover),
  "--surface-l2": h(palette.hover),
  "--surface-l2-active": h(palette.active),
  "--surface-l3": h(palette.active),
  "--surface-l4": h(palette.active),
  "--surface-l4-hover": h(palette.active),
  "--surface-elevated": h(palette.surfaceOverlay),
  "--surface-composer": h(palette.surfaceRaised),
  "--surface-user-bubble": h(palette.message),
  "--warm-white": h(palette.surface),
  "--input-background": toHex(palette.surfaceRaised),
  "--input-hover": toHex(palette.hover),
  "--input-button-background": toHex(palette.hover),
  "--input-button-background-hover": toHex(palette.active),
  "--popover": toHex(palette.surfaceOverlay),
  "--card-foreground": h(palette.text),
  "--popover-foreground": h(palette.text),
  "--fg-primary": h(palette.text),
  "--fg-secondary": h(palette.textSecondary),
  "--fg-tertiary": h(palette.textMuted),
  "--fg-quaternary": h(palette.textMuted),
  "--fg-accent": h(palette.accent),
  "--fg-accent-hover": h(palette.accentHover),
  "--fg-link": h(palette.accent),
  "--border": h(palette.border),
  "--muted": h(palette.surface),
  "--accent": h(palette.hover),
  "--accent-foreground": h(palette.text),
  "--secondary-foreground": h(palette.text),
  "--sidebar-background": h(palette.sidebar),
  "--sidebar-foreground": h(palette.sidebarText),
  "--sidebar-accent": h(palette.sidebarSelected),
  "--sidebar-accent-foreground": h(palette.sidebarText),
  "--sidebar-border": h(palette.border),
  "--cookie-consent-surface": toHex(palette.canvas),
})}
}
/* Grok's composer hint uses this class without shipping a rule for it, so it
   inherits the light prose body gray. */
.text-fg-secondary {
  color: hsl(var(--fg-secondary));
}
${pageBase(palette, colorScheme)}`;
};

const buildGeminiCss = (
  palette: Palette,
  colorScheme: string,
): string => `/* ndev.t3code theme for the isolated Gemini surface. */
:root,
body {
${declarations({
  "--gem-sys-color--surface": toHex(palette.canvas),
  "--gem-sys-color--surface-dim": toHex(palette.sidebar),
  "--gem-sys-color--surface-bright": toHex(palette.surfaceRaised),
  "--gem-sys-color--surface-container-lowest": toHex(palette.sidebar),
  "--gem-sys-color--surface-container-low": toHex(palette.sidebar),
  "--gem-sys-color--surface-container": toHex(palette.surface),
  "--gem-sys-color--surface-container-high": toHex(palette.hover),
  "--gem-sys-color--surface-container-highest": toHex(palette.active),
  "--gem-sys-color--on-surface": toHex(palette.text),
  "--gem-sys-color--on-surface-variant": toHex(palette.textSecondary),
  "--gem-sys-color--on-surface-low": toHex(palette.textMuted),
  "--gem-sys-color--outline": toHex(palette.textMuted),
  "--gem-sys-color--outline-variant": toHex(palette.border),
  "--gem-sys-color--outline-low": toHex(palette.border),
  "--gem-sys-color--primary": toHex(palette.accent),
  "--gem-sys-color--on-primary": toHex(palette.accentForeground),
  "--gem-sys-color--primary-container": toHex(palette.accentSurface),
  "--gem-sys-color--on-primary-container": toHex(palette.text),
  "--lumi-sys-color--surface": toHex(palette.canvas),
  "--lumi-sys-color--surface-dim": toHex(palette.sidebar),
  "--lumi-sys-color--surface-bright": toHex(palette.surfaceRaised),
  "--lumi-sys-color--on-surface": toHex(palette.text),
  "--lumi-sys-color-acc-color--accent-fixed": toHex(palette.accent),
  "--mat-app-background-color": toHex(palette.canvas),
  "--mat-app-text-color": toHex(palette.text),
  "--mat-divider-color": toHex(palette.border),
  "--bard-color-synthetic--chat-window-surface": toHex(palette.canvas),
  "--bard-color-synthetic--chat-window-surface-container": toHex(palette.canvas),
  "--bard-color-synthetic--chat-window-surface-container-highest": toHex(palette.canvas),
  "--bard-color-synthetic--mat-card-background": toHex(palette.surface),
  "--bard-color-sidenav-background-mobile": toHex(palette.sidebar),
  "--bard-color-response-container-flipped-background": toHex(palette.message),
})}
}
/* The greeting glow and blurred gradient blobs repaint constantly and clash with the T3 canvas. */
.nl-blob,
.lm-glow {
  display: none !important;
}
${pageBase(palette, colorScheme)}`;

const SITE_THEME_BUILDERS: Record<
  Exclude<RemoteAppSite, "chatgpt">,
  (palette: Palette, colorScheme: string) => string
> = {
  claude: buildClaudeCss,
  grok: buildGrokCss,
  gemini: buildGeminiCss,
};

/* Sites ship app-region CSS for their own desktop apps (ChatGPT marks its whole
   52px header draggable). Inside a view that turns their header controls into
   window drag handles; the host titlebar already drags the window. */
const SITE_NO_DRAG_CSS = `*, *::before, *::after {
  -webkit-app-region: no-drag !important;
}`;

/* Pins each site's sidebar to the T3 sidebar width so the host's titlebar and
   footer columns line up with the page's own sidebar edge. A stylesheet
   !important beats the inline custom properties Grok and ChatGPT set. */
const SIDEBAR_WIDTH_RULES: Record<RemoteAppSite, (width: number) => string> = {
  // Only while ChatGPT's own panel is open, so its collapse still works. The
  // inner panel carries an inline width from --codex-sidebar-preferred-width.
  // Beside the icon rail a narrow panel can't fit a section's header title
  // ("ChatGPT", "Space", "Scheduled") as well as its buttons, and clips it; the
  // rail already marks the active section, so the title goes and the buttons
  // stay right-aligned as on Home.
  chatgpt: (width) => `:root {
  --codex-sidebar-preferred-width: ${width}px !important;
}
[data-app-shell-sidebar-open="true"] [style*="--app-shell-left-panel-width"] {
  --app-shell-left-panel-width: ${width}px !important;
}
[data-app-shell-sidebar-open="true"] aside.app-shell-left-panel > div > div {
  width: 100% !important;
  min-width: 0 !important;
}
#app-shell-sidebar [class*="@container/navigation-header"] > :first-child:not(:last-child) {
  display: none !important;
}
#app-shell-sidebar [class*="@container/navigation-header"] > :last-child {
  margin-inline-start: auto !important;
}`,
  claude: (width) => `aside.dframe-sidebar {
  width: ${width}px !important;
  min-width: ${width}px !important;
  max-width: ${width}px !important;
}`,
  // Grok's sidebar is content-box with a 1px edge border.
  grok: (width) => `:root,
[style*="--sidebar-width"] {
  --sidebar-width: ${width - 1}px !important;
}`,
  gemini: (width) => `:root,
bard-sidenav {
  --bard-sidenav-open-width: ${width}px !important;
}`,
};

/**
 * CSS that repaints a site's own design tokens with the active T3 palette.
 * ChatGPT keeps its fuller treatment; the others only remap their tokens, so
 * their layouts stay as the sites ship them.
 */
export const buildRemoteSiteThemeCss = (site: RemoteAppSite, input: RemoteAppTheme): string => {
  const theme = normalizeRemoteAppTheme(input);
  const colorScheme = theme.appearance === "dark" ? "dark" : "light";
  const css = `${SITE_NO_DRAG_CSS}\n${
    site === "chatgpt"
      ? buildRemoteAppThemeCss(input)
      : SITE_THEME_BUILDERS[site](resolvePalette(theme.colors), colorScheme)
  }`;
  return theme.sidebarWidth === null
    ? css
    : `${css}\n\n${SIDEBAR_WIDTH_RULES[site](theme.sidebarWidth)}\n`;
};
