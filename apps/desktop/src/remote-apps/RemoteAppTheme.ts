import type { RemoteAppTheme, RemoteAppThemeColors } from "@t3tools/contracts";

const SAFE_THEME_COLOR = /^[a-zA-Z0-9#(),.%/ +*-]+$/;

/**
 * A blue-gray fallback prevents a black flash before the renderer has sent its
 * current palette across IPC. The renderer immediately replaces this with the
 * active T3 palette, including user-created themes.
 */
export const DEFAULT_REMOTE_APP_THEME: RemoteAppTheme = {
  appearance: "dark",
  sidebarWidth: null,
  colors: {
    canvas: "#192531",
    sidebar: "#1b2a39",
    sidebarForeground: "#edf3f8",
    sidebarMutedForeground: "#9ba8b5",
    sidebarRowHover: "#253543",
    sidebarRowSelected: "#304657",
    sidebarBorder: "#3d4d5b",
    surface: "#273542",
    surfaceRaised: "#2f3d4b",
    surfaceOverlay: "#344653",
    text: "#eff4f8",
    textMuted: "#a7b1bd",
    muted: "#344452",
    mutedForeground: "#b0bac4",
    placeholder: "#9aa7b4",
    border: "#42525f",
    input: "#31404d",
    focus: "#8cb8ff",
    accent: "#8cb8ff",
    accentForeground: "#16222c",
    secondary: "#30404d",
    secondaryForeground: "#eff4f8",
    toolbar: "#16212b",
    toolbarForeground: "#eff4f8",
    toolbarBorder: "#3f4f5d",
    toolbarControl: "#2b3b49",
    toolbarControlForeground: "#eff4f8",
    messageSurface: "#2a3a49",
    messageForeground: "#eff4f8",
    messageAction: "#8cb8ff",
    messageActionForeground: "#15212b",
    messageActionHover: "#a9cbff",
    codeBackground: "#17232e",
    codeForeground: "#eaf2fb",
  },
};

const COLOR_KEYS = Object.keys(DEFAULT_REMOTE_APP_THEME.colors) as Array<
  keyof RemoteAppThemeColors
>;

const safeColor = (value: string, fallback: string): string => {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 && SAFE_THEME_COLOR.test(normalized)
    ? normalized
    : fallback;
};

export const normalizeRemoteAppTheme = (theme: RemoteAppTheme): RemoteAppTheme => ({
  appearance: theme.appearance,
  sidebarWidth:
    theme.sidebarWidth === null || !Number.isFinite(theme.sidebarWidth)
      ? null
      : Math.min(512, Math.max(160, Math.round(theme.sidebarWidth))),
  colors: Object.fromEntries(
    COLOR_KEYS.map((key) => [
      key,
      safeColor(theme.colors[key], DEFAULT_REMOTE_APP_THEME.colors[key]),
    ]),
  ) as RemoteAppThemeColors,
});

export const isChatGptRemoteAppUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "chatgpt.com" || parsed.hostname.endsWith(".chatgpt.com"))
    );
  } catch {
    return false;
  }
};

/**
 * Restores the native site's expected editor focus after its add-files popover
 * dismisses. The handler is limited to editable controls and is installed in
 * the remote document, so it cannot affect the T3 renderer or other origins.
 */
export const buildRemoteAppInteractionScript = (): string => `
(() => {
  const key = "__t3codeRemoteAppInteraction";
  if (window[key]) return;

  const focusEditable = (target) => {
    if (!(target instanceof Element)) return;
    const editable = target.closest("textarea, [contenteditable='true']");
    if (!(editable instanceof HTMLElement)) return;

    const focus = () => {
      if (editable.isConnected) editable.focus({ preventScroll: true });
    };
    queueMicrotask(focus);
    window.setTimeout(focus, 0);
  };

  document.addEventListener("pointerdown", (event) => focusEditable(event.target), true);
  document.addEventListener("click", (event) => focusEditable(event.target), true);
  window[key] = true;
})();
`;

/**
 * ChatGPT is still the real remote site. This user stylesheet only changes
 * presentation: it does not replace markup, intercept requests, or touch the
 * dedicated session's cookies/storage. Token selectors cover ChatGPT's stable
 * design-token classes; semantic fallbacks keep the canvas and sidebar aligned
 * if those implementation classes change.
 */
export const buildRemoteAppThemeCss = (input: RemoteAppTheme): string => {
  const { appearance, sidebarWidth, colors } = normalizeRemoteAppTheme(input);
  const colorScheme = appearance === "dark" ? "dark" : "light";
  const sidebarWidthVariable =
    sidebarWidth === null ? "" : `\n  --sidebar-width: ${sidebarWidth}px !important;`;
  const sidebarWidthRule =
    sidebarWidth === null
      ? ""
      : `\n  width: ${sidebarWidth}px !important;\n  min-width: ${sidebarWidth}px !important;`;
  return `
/* T3 Code scoped theme for the isolated ChatGPT surface. */
:root {
  color-scheme: ${colorScheme} !important;
${sidebarWidthVariable}
  --t3code-remote-canvas: ${colors.canvas};
  --t3code-remote-sidebar: ${colors.sidebar};
  --t3code-remote-sidebar-foreground: ${colors.sidebarForeground};
  --t3code-remote-sidebar-muted-foreground: ${colors.sidebarMutedForeground};
  --t3code-remote-sidebar-row-hover: ${colors.sidebarRowHover};
  --t3code-remote-sidebar-row-selected: ${colors.sidebarRowSelected};
  --t3code-remote-sidebar-border: ${colors.sidebarBorder};
  --t3code-remote-surface: ${colors.surface};
  --t3code-remote-surface-raised: ${colors.surfaceRaised};
  --t3code-remote-surface-overlay: ${colors.surfaceOverlay};
  --t3code-remote-text: ${colors.text};
  --t3code-remote-text-muted: ${colors.textMuted};
  --t3code-remote-muted: ${colors.muted};
  --t3code-remote-muted-foreground: ${colors.mutedForeground};
  --t3code-remote-placeholder: ${colors.placeholder};
  --t3code-remote-border: ${colors.border};
  --t3code-remote-input: ${colors.input};
  --t3code-remote-focus: ${colors.focus};
  --t3code-remote-accent: ${colors.accent};
  --t3code-remote-accent-foreground: ${colors.accentForeground};
  --t3code-remote-secondary: ${colors.secondary};
  --t3code-remote-secondary-foreground: ${colors.secondaryForeground};
  --t3code-remote-toolbar: ${colors.toolbar};
  --t3code-remote-toolbar-foreground: ${colors.toolbarForeground};
  --t3code-remote-toolbar-border: ${colors.toolbarBorder};
  --t3code-remote-toolbar-control: ${colors.toolbarControl};
  --t3code-remote-toolbar-control-foreground: ${colors.toolbarControlForeground};
  --main-surface-primary: var(--t3code-remote-canvas) !important;
  --main-surface-secondary: var(--t3code-remote-surface-raised) !important;
  --main-surface-tertiary: var(--t3code-remote-surface-raised) !important;
  --composer-surface: var(--t3code-remote-surface-raised) !important;
  --composer-surface-primary: var(--t3code-remote-surface-raised) !important;
  --composer-surface-secondary: var(--t3code-remote-surface-raised) !important;
  --sidebar-surface-primary: var(--t3code-remote-sidebar) !important;
  --sidebar-surface-secondary: var(--t3code-remote-surface) !important;
  --text-primary: var(--t3code-remote-text) !important;
  --text-secondary: var(--t3code-remote-text-muted) !important;
  --text-tertiary: var(--t3code-remote-muted-foreground) !important;
  --border-light: var(--t3code-remote-border) !important;
  --border-medium: var(--t3code-remote-border) !important;
  --border-heavy: var(--t3code-remote-border) !important;
  --interactive-bg-secondary-hover: var(--t3code-remote-sidebar-row-hover) !important;
}

html,
body {
  min-height: 100%;
  background-color: var(--t3code-remote-canvas) !important;
  color: var(--t3code-remote-text) !important;
  scrollbar-color: var(--t3code-remote-muted) var(--t3code-remote-canvas) !important;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif !important;
}

main,
[role="main"] {
  background-color: var(--t3code-remote-canvas) !important;
  color: var(--t3code-remote-text) !important;
}

nav,
[role="complementary"],
[data-testid="sidebar"],
[data-testid*="sidebar"],
aside,
[aria-label="Chat history"],
[class~="group/sidebar"] {
  background-color: var(--t3code-remote-sidebar) !important;
  color: var(--t3code-remote-sidebar-foreground) !important;
  border-color: var(--t3code-remote-sidebar-border) !important;
${sidebarWidthRule}
}

:where(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) a {
  color: var(--t3code-remote-sidebar-foreground) !important;
}

:where(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) a:hover {
  background-color: var(--t3code-remote-sidebar-row-hover) !important;
}

:where(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) :where(
  [class~="text-token-text-secondary"],
  [class~="text-token-text-tertiary"]
) {
  color: var(--t3code-remote-sidebar-muted-foreground) !important;
}

/* The live sidebar currently gives several utility rows their own border.
   Keep the sidebar's outer edge, but make its child rows read as one clean
   list like T3's native sidebar. */
:where(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) :where(a, button, [role="button"], li, ul, ol, [class*="border"], [class*="divide"]) {
  border-top-color: transparent !important;
  border-right-color: transparent !important;
  border-bottom-color: transparent !important;
  border-left-color: transparent !important;
  box-shadow: none !important;
}

:where(
  [class~="bg-token-main-surface-primary"],
  [class~="bg-token-main-surface-secondary"],
  [class~="bg-token-main-surface-tertiary"],
  [class~="bg-token-surface-primary"],
  [class~="bg-token-surface-secondary"]
) {
  background-color: var(--t3code-remote-surface) !important;
}

:where([class~="bg-token-main-surface-primary"], [class~="bg-token-surface-primary"]) {
  background-color: var(--t3code-remote-canvas) !important;
}

:where([class~="bg-token-sidebar-surface-primary"], [class~="bg-token-sidebar-surface-secondary"]) {
  background-color: var(--t3code-remote-sidebar) !important;
}

:where(
  [class~="text-token-text-primary"],
  [class~="text-token-text-secondary"],
  [class~="text-token-text-tertiary"]
) {
  color: var(--t3code-remote-text) !important;
}

:where([class~="text-token-text-secondary"], [class~="text-token-text-tertiary"]) {
  color: var(--t3code-remote-text-muted) !important;
}

:where([class*="border-token"], [class*="divide-token"]) {
  border-color: var(--t3code-remote-border) !important;
}

:where(button, [role="button"]):focus-visible,
:where(textarea, [contenteditable="true"]):focus-visible {
  outline-color: var(--t3code-remote-focus) !important;
  --tw-ring-color: var(--t3code-remote-focus) !important;
}

main :where(
  form:has(textarea),
  form:has([contenteditable="true"]),
  [data-testid*="composer"],
  [class*="composer"],
  div:has(> textarea),
  div:has(> [contenteditable="true"])
) {
  background-color: var(--t3code-remote-surface-raised) !important;
  background-image: none !important;
  border-style: solid !important;
  border-width: 1px !important;
  border-color: var(--t3code-remote-border) !important;
  color: var(--t3code-remote-text) !important;
  box-shadow: 0 1px 0 rgb(255 255 255 / 4%) inset, 0 10px 28px rgb(0 0 0 / 12%) !important;
}

main :where(button, [role="button"]) {
  color: var(--t3code-remote-text) !important;
}

main :where(
  form:has(textarea),
  form:has([contenteditable="true"]),
  [data-testid*="composer"],
  [class*="composer"],
  div:has(> textarea),
  div:has(> [contenteditable="true"])
) :where(textarea, [contenteditable="true"]) {
  background: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
}

:where(textarea, [contenteditable="true"]) {
  color: var(--t3code-remote-text) !important;
  caret-color: var(--t3code-remote-accent) !important;
}

:where(textarea, [contenteditable="true"])::placeholder {
  color: var(--t3code-remote-placeholder) !important;
}

main :where(a),
[role="main"] :where(a) {
  color: var(--t3code-remote-accent) !important;
}

:where([class~="bg-token-main-surface-secondary"], [class~="bg-token-surface-secondary"]) {
  background-color: var(--t3code-remote-surface-raised) !important;
}

:where([class~="bg-token-text-primary"]) {
  background-color: var(--t3code-remote-text) !important;
}

::selection {
  background-color: var(--t3code-remote-accent) !important;
  color: var(--t3code-remote-accent-foreground) !important;
}
`;
};
