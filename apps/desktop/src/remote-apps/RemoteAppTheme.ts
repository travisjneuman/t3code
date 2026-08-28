import type { DesktopSurface, RemoteAppTheme, RemoteAppThemeColors } from "@t3tools/contracts";

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

  const getEditable = (target) => {
    if (!(target instanceof Element)) return null;
    const direct = target.closest("textarea, [contenteditable='true']");
    if (direct instanceof HTMLElement) return direct;
    const textbox = target.closest("[role='textbox']");
    return textbox?.querySelector("textarea, [contenteditable='true']") ?? null;
  };

  const closeOpenAddFilesPopover = () => {
    const trigger = document.querySelector(
      "button[aria-label*='Add files'], button[aria-label*='files']",
    );
    const triggerIsOpen =
      trigger instanceof HTMLElement &&
      (trigger.getAttribute("aria-expanded") === "true" ||
        trigger.getAttribute("data-state") === "open");
    const openPopover = Array.from(
      document.querySelectorAll(
        "[role='menu'], [data-radix-popper-content-wrapper], [data-state='open'], [aria-expanded='true']",
      ),
    ).find((candidate) => {
      if (candidate === trigger) return false;
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    if (!(trigger instanceof HTMLElement) || (!triggerIsOpen && openPopover === undefined)) return;
    trigger.click();
  };

  const focusEditable = (target) => {
    const editable = getEditable(target);
    if (!(editable instanceof HTMLElement)) return;

    const focus = () => {
      if (!editable.isConnected) return;
      closeOpenAddFilesPopover();
      editable.focus({ preventScroll: true });
      if (document.activeElement !== editable) editable.click();
      editable.focus({ preventScroll: true });
    };
    queueMicrotask(focus);
    window.setTimeout(focus, 0);
    window.setTimeout(focus, 32);
    window.setTimeout(focus, 80);
  };

  for (const eventName of ["pointerdown", "mousedown", "click", "focusin"]) {
    document.addEventListener(eventName, (event) => focusEditable(event.target), true);
  }
  window[key] = true;
})();
`;

const surfaceMenuUrl = (surface: DesktopSurface): string => `t3code-surface://select/${surface}`;

/**
 * The surface picker is rendered in a small host-owned window. A remote
 * WebContentsView is composited above the renderer, so a renderer popover
 * cannot reliably appear over ChatGPT. Keep this document intentionally small
 * and self-contained so it remains available while the remote surface is
 * loading or offline.
 */
export const buildRemoteAppSurfaceMenuHtml = (
  input: RemoteAppTheme,
  activeSurface: DesktopSurface,
): string => {
  const { appearance, colors } = normalizeRemoteAppTheme(input);
  const checked = (surface: DesktopSurface): string =>
    activeSurface === surface ? "true" : "false";
  return `<!doctype html>
<html lang="en" data-theme="${appearance}">
  <head>
    <meta charset="utf-8">
    <style>
      :root { color-scheme: ${appearance}; }
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
      body {
        padding: 6px;
        background: transparent;
        color: ${colors.text};
        font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
      }
      [role="menu"] {
        width: 184px;
        padding: 5px;
        border: 1px solid ${colors.toolbarBorder};
        border-radius: 12px;
        background: ${colors.surfaceOverlay};
        box-shadow: 0 14px 32px rgb(0 0 0 / 32%), 0 1px 0 rgb(255 255 255 / 8%) inset;
      }
      [role="menuitemradio"] {
        display: flex;
        align-items: center;
        min-height: 32px;
        gap: 8px;
        padding: 5px 8px;
        border-radius: 8px;
        color: ${colors.text};
        font-size: 13px;
        font-weight: 500;
        line-height: 20px;
        text-decoration: none;
        outline: none;
      }
      [role="menuitemradio"]:hover,
      [role="menuitemradio"]:focus-visible,
      [role="menuitemradio"][aria-checked="true"] {
        background: ${colors.sidebarRowSelected};
      }
      [role="menuitemradio"]:focus-visible {
        box-shadow: 0 0 0 2px ${colors.focus} inset;
      }
      .check { width: 14px; color: ${colors.accent}; font-size: 14px; text-align: center; }
      .check[aria-hidden="true"] { flex: 0 0 14px; }
    </style>
  </head>
  <body>
    <div role="menu" aria-label="Switch app surface">
      <a role="menuitemradio" aria-checked="${checked("t3code")}" href="${surfaceMenuUrl("t3code")}">
        <span class="check" aria-hidden="true">${activeSurface === "t3code" ? "✓" : ""}</span>
        <span>T3 Code</span>
      </a>
      <a role="menuitemradio" aria-checked="${checked("chatgpt")}" href="${surfaceMenuUrl("chatgpt")}">
        <span class="check" aria-hidden="true">${activeSurface === "chatgpt" ? "✓" : ""}</span>
        <span>ChatGPT</span>
      </a>
    </div>
  </body>
</html>`;
};

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
  --sidebar-surface-secondary: var(--t3code-remote-sidebar) !important;
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
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) * {
  border-color: transparent !important;
}

:where(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) *::before,
:where(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) *::after {
  border-color: transparent !important;
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
  [class~="group/composer"]
) {
  background: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
  color: var(--t3code-remote-text) !important;
}

main :where(
  form:has(textarea) div:has(> textarea),
  form:has([contenteditable="true"]) div:has(> [contenteditable="true"]),
  [data-testid*="composer"] div:has(> textarea),
  [data-testid*="composer"] div:has(> [contenteditable="true"]),
  [class~="group/composer"] div:has(> textarea),
  [class~="group/composer"] div:has(> [contenteditable="true"])
) {
  background: var(--t3code-remote-surface-raised) !important;
  border: 1px solid var(--t3code-remote-border) !important;
  border-radius: 1.5rem !important;
  box-shadow: 0 1px 0 rgb(255 255 255 / 5%) inset, 0 10px 28px rgb(0 0 0 / 16%) !important;
}

main :where(button, [role="button"]) {
  color: var(--t3code-remote-text) !important;
}

main :where(
  form:has(textarea),
  form:has([contenteditable="true"]),
  [data-testid*="composer"],
  [class~="group/composer"]
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

/* Keep row separators out of the remote utility list. This is intentionally
   last so it wins over the site's later token-border rules. */
:where(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) :where(a, button, [role="button"], li, ul, ol, [class*="border"], [class*="divide"]) {
  border-color: transparent !important;
  box-shadow: none !important;
}

:where(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) :where(a, button, [role="button"], li, ul, ol, [class*="border"], [class*="divide"])::before,
:where(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) :where(a, button, [role="button"], li, ul, ol, [class*="border"], [class*="divide"])::after {
  border-color: transparent !important;
  box-shadow: none !important;
}

:where(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) * {
  border-color: transparent !important;
  box-shadow: none !important;
}

:where(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) :where(hr, [role="separator"]) {
  height: 0 !important;
  border: 0 !important;
  background: transparent !important;
}

:where(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) *::before,
:where(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) *::after {
  border-color: transparent !important;
  box-shadow: none !important;
}

/* ChatGPT's utility rows use token classes with greater specificity than a
   zero-specificity :where() selector. Prefix the final reset with the live
   document roots so the remote site's row borders cannot reappear after a
   navigation or a React rerender. Background images are cleared only from
   border/divider-marked descendants; icons and other sidebar decoration stay
   intact. */
html body :is(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) :is(a, button, [role="button"], li, ul, ol, [class*="border"], [class*="divide"]) {
  border: 0 !important;
  border-color: transparent !important;
  box-shadow: none !important;
  background-image: none !important;
}

html body :is(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) :is(hr, [role="separator"], [class*="border"], [class*="divide"]) {
  border: 0 !important;
  background: transparent !important;
  background-image: none !important;
  box-shadow: none !important;
}

html body :is(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"]
) :is(hr, [role="separator"]) {
  height: 0 !important;
  min-height: 0 !important;
}
`;
};
