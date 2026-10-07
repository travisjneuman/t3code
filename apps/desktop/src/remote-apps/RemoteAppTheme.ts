import {
  REMOTE_APP_SITE_INFO,
  REMOTE_APP_THEME_STAGE_COLOR_MAX_LENGTH,
  type DesktopSurface,
  type RemoteAppMenuTheme,
  type RemoteAppTheme,
  type RemoteAppThemeColors,
} from "@t3tools/contracts";
import { PRODUCT_NAME } from "@t3tools/shared/branding";

import { REMOTE_APP_SURFACE_ICONS } from "./RemoteAppSurfaceIcons.ts";

const SAFE_THEME_COLOR = /^[a-zA-Z0-9#(),.%/ +*-]+$/;
const REMOTE_APP_THEME_COLOR_MAX_LENGTH = 128;

/**
 * A blue-gray fallback prevents a black flash before the renderer has sent its
 * current palette across IPC. The renderer immediately replaces this with the
 * active T3 palette, including user-created themes.
 */
export const DEFAULT_REMOTE_APP_THEME: RemoteAppTheme = {
  appearance: "dark",
  stageArt: "none",
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
    toolbarControlHover: "#344b5b",
    messageSurface: "#2a3a49",
    messageForeground: "#eff4f8",
    messageAction: "#8cb8ff",
    messageActionForeground: "#15212b",
    messageActionHover: "#a9cbff",
    codeBackground: "#17232e",
    codeForeground: "#eaf2fb",
    stageArtTop: "oklch(0.581473 0.149124 256.9)",
    stageArtMid: "oklch(0.456509 0.159377 261.945)",
    stageArtBottom: "oklch(0.291327 0.136578 267.649)",
    stageArtHighlight: "oklch(0.951597 0.037289 215.482)",
    stageArtSecondary: "oklch(0.794668 0.12136 235.46)",
    stageArtTertiary: "oklch(0.678991 0.170261 275.365)",
    stageArtLine: "oklch(0.959666 0.029238 218.179)",
    stageArtCelesteHighlight: "oklch(0.968763 0.045822 196.42)",
    stageArtCelesteSecondary: "oklch(0.827395 0.126071 211.26)",
    stageArtVioletHighlight: "oklch(0.895381 0.053248 286.447)",
    stageArtGridLine: "oklch(0.966822 0.01757 239.99)",
    stageNightTop: "oklch(0.283792 0.117327 297.201)",
    stageNightMid: "oklch(0.227147 0.086086 277.99)",
    stageNightBottom: "oklch(0.200528 0.055699 261.216)",
    stageNightHighlight: "oklch(0.707246 0.157418 252.091)",
    stageNightSecondary: "oklch(0.600473 0.182225 277.296)",
    stageNightTertiary: "oklch(0.62583 0.210886 305.994)",
    stageNightLine: "oklch(0.938794 0.029114 273.103)",
    stageNightGlowHighlight: "oklch(0.553749 0.176543 271.958)",
    stageNightGlowSecondary: "oklch(0.345571 0.117466 273.568)",
    stageNightSparkle: "oklch(0.880867 0.057747 269.011)",
  },
};

const COLOR_KEYS = Object.keys(DEFAULT_REMOTE_APP_THEME.colors) as Array<
  keyof RemoteAppThemeColors
>;

const safeColor = (
  value: string,
  fallback: string,
  maxLength = REMOTE_APP_THEME_COLOR_MAX_LENGTH,
): string => {
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= maxLength &&
    SAFE_THEME_COLOR.test(normalized)
    ? normalized
    : fallback;
};

const MENU_KEYS = [
  "glass",
  "popover",
  "foreground",
  "mutedForeground",
  "highlight",
  "highlightForeground",
  "border",
  "separator",
] as const satisfies ReadonlyArray<keyof RemoteAppMenuTheme>;

/** Menu colors from the palette, for a renderer that has not sent its own yet. */
const fallbackMenuTheme = (colors: RemoteAppThemeColors): RemoteAppMenuTheme => ({
  glass: colors.surfaceOverlay,
  popover: colors.surfaceOverlay,
  foreground: colors.text,
  mutedForeground: colors.mutedForeground,
  highlight: colors.sidebarRowHover,
  highlightForeground: colors.text,
  border: colors.border,
  separator: colors.border,
});

const normalizeMenuTheme = (
  menu: RemoteAppMenuTheme,
  colors: RemoteAppThemeColors,
): RemoteAppMenuTheme => {
  const fallback = fallbackMenuTheme(colors);
  return Object.fromEntries(
    MENU_KEYS.map((key) => [key, safeColor(menu[key], fallback[key])]),
  ) as RemoteAppMenuTheme;
};

export const normalizeRemoteAppTheme = (theme: RemoteAppTheme): RemoteAppTheme => {
  const colors = Object.fromEntries(
    COLOR_KEYS.map((key) => [
      key,
      safeColor(
        theme.colors[key],
        DEFAULT_REMOTE_APP_THEME.colors[key],
        key.startsWith("stage") ? REMOTE_APP_THEME_STAGE_COLOR_MAX_LENGTH : undefined,
      ),
    ]),
  ) as RemoteAppThemeColors;
  return {
    appearance: theme.appearance === "light" ? "light" : "dark",
    stageArt: theme.stageArt === "nightly" || theme.stageArt === "dev" ? theme.stageArt : "none",
    sidebarWidth:
      theme.sidebarWidth === null || !Number.isFinite(theme.sidebarWidth)
        ? null
        : Math.min(512, Math.max(160, Math.round(theme.sidebarWidth))),
    colors,
    ...(theme.menu === undefined ? {} : { menu: normalizeMenuTheme(theme.menu, colors) }),
  };
};

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
  const existing = window[key];
  if (existing && typeof existing.refresh === "function") {
    existing.refresh();
    return;
  }

  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  const applyComposerMarkers = () => {
    for (const previous of document.querySelectorAll(
      "[data-t3code-remote-composer-root], [data-t3code-remote-composer-shell], [data-t3code-remote-composer-editable]",
    )) {
      delete previous.dataset.t3codeRemoteComposerRoot;
      delete previous.dataset.t3codeRemoteComposerShell;
      delete previous.dataset.t3codeRemoteComposerEditable;
    }

    const main = document.querySelector("main, [role='main']");
    if (!(main instanceof HTMLElement)) return;
    const editables = Array.from(
      main.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']"),
    );
    for (const candidate of editables) {
      const editable =
        candidate instanceof HTMLElement &&
        (candidate.matches("textarea, [contenteditable='true']") ||
          candidate.getAttribute("role") === "textbox")
          ? candidate
          : null;
      if (!(editable instanceof HTMLElement) || !isVisible(editable)) continue;
      const form = editable.closest("form");
      if (!(form instanceof HTMLFormElement)) continue;
      const addFilesTrigger = form.querySelector(
        "button[aria-label*='Add files' i], button[aria-label*='Upload' i]",
      );
      const isKnownPrompt = editable.id === "prompt-textarea";
      if (!isKnownPrompt && !(addFilesTrigger instanceof HTMLElement)) continue;

      let shell = editable.parentElement;
      while (shell instanceof HTMLElement && shell !== form) {
        const rect = shell.getBoundingClientRect();
        if (
          (addFilesTrigger === null ? isKnownPrompt : shell.contains(addFilesTrigger)) &&
          rect.width >= editable.getBoundingClientRect().width &&
          rect.height >= 40 &&
          rect.height <= 320
        ) {
          break;
        }
        shell = shell.parentElement;
      }
      const resolvedShell = shell instanceof HTMLElement ? shell : form;
      form.dataset.t3codeRemoteComposerRoot = "true";
      resolvedShell.dataset.t3codeRemoteComposerShell = "true";
      editable.dataset.t3codeRemoteComposerEditable = "true";
      return;
    }
  };

  const applySemanticMarkers = applyComposerMarkers;
  let semanticTimer = 0;
  const scheduleSemanticMarkers = () => {
    if (semanticTimer !== 0) return;
    semanticTimer = window.setTimeout(() => {
      semanticTimer = 0;
      applySemanticMarkers();
    }, 80);
  };
  applySemanticMarkers();
  for (const delay of [0, 120, 500, 1_200, 3_000, 6_000, 10_000]) {
    window.setTimeout(applySemanticMarkers, delay);
  }

  const getEditable = (target) => {
    if (!(target instanceof Element)) return null;
    const direct = target.closest("[data-t3code-remote-composer-editable='true']");
    if (direct instanceof HTMLElement) return direct;
    if (
      target.closest(
        "button, a, input, select, [role='button'], [role='menuitem'], [role='option']",
      )
    ) {
      return null;
    }
    const composer = target.closest("[data-t3code-remote-composer-root='true']");
    return composer?.querySelector("[data-t3code-remote-composer-editable='true']") ?? null;
  };

  const getOpenAddFilesPopover = () => {
    const composer = document.querySelector("[data-t3code-remote-composer-root='true']");
    const trigger = composer?.querySelector(
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
    return { open: triggerIsOpen || openPopover !== undefined, trigger };
  };

  const dispatchEscape = () => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Escape",
      key: "Escape",
      keyCode: 27,
      which: 27,
    });
    document.dispatchEvent(event);
    window.dispatchEvent(event);
  };

  const closeOpenAddFilesPopover = () => {
    const { open, trigger } = getOpenAddFilesPopover();
    if (!open) return;

    // ChatGPT's current attachment picker is a non-modal popover. Its outside
    // click path is not consistently reached when the user clicks the editor,
    // so use the same Escape dismissal the site uses for keyboard focus changes
    // and retain a trigger fallback for older site revisions.
    dispatchEscape();
    if (!getOpenAddFilesPopover().open && !(trigger instanceof HTMLElement)) return;
    if (trigger instanceof HTMLElement) {
      trigger.click();
      if (getOpenAddFilesPopover().open) {
        trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }
    }
  };

  const focusEditable = (target) => {
    const editable = getEditable(target);
    if (!(editable instanceof HTMLElement)) return;
    if (document.activeElement === editable && !getOpenAddFilesPopover().open) return;

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
    window.setTimeout(focus, 160);
  };

  const resolveTryItFirstUrl = () => {
    // The auth page's logo currently points at /?slm=1; that query is a
    // login-state marker and redirects the guest entry back to auth. The
    // plain same-origin root is ChatGPT's signed-out guest entry point.
    return new URL("/", window.location.origin).href;
  };

  const handleTryItFirst = (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest("a");
    if (!(link instanceof HTMLAnchorElement)) return;
    const accessibleName = (link.getAttribute("aria-label") ?? link.textContent ?? "")
      .trim()
      .replace(/\\s+/g, " ")
      .toLowerCase();
    if (accessibleName !== "try it first") return;

    // On the login route this link is currently emitted as a hash anchor. Take
    // ownership of that exact inert action before the site's router can turn it
    // into another nested auth URL, while leaving every other remote link
    // untouched.
    const targetUrl = resolveTryItFirstUrl();
    event.preventDefault();
    event.stopPropagation();
    window.location.assign(targetUrl);
  };

  document.addEventListener("click", handleTryItFirst, true);

  for (const eventName of ["pointerdown", "mousedown", "click"]) {
    document.addEventListener(eventName, (event) => focusEditable(event.target), true);
  }
  window[key] = {
    refresh() {
      scheduleSemanticMarkers();
    },
  };
})();
`;

const surfaceMenuUrl = (surface: DesktopSurface): string => `t3code-surface://select/${surface}`;

// Lucide's panel-right, the icon T3 uses for its right panel.
const SIDE_PANEL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>';

/**
 * The surface picker is rendered in a small host-owned window. A remote
 * WebContentsView is composited above the renderer, so a renderer popover
 * cannot reliably appear over a remote site. Keep this document intentionally
 * small and self-contained so it remains available while the remote surface is
 * loading or offline. Its rows mirror T3's MenuItem: 28px, 6px radius, 14px
 * text, a muted 16px icon, and the accent highlight.
 */
// T3's MenuPopup minimum width; every label fits inside it.
export const REMOTE_APP_SURFACE_MENU_WIDTH = 160;
const SURFACE_MENU_ITEM_HEIGHT = 28;
// Popup padding (2 * 4px) and border (2 * 1px).
const SURFACE_MENU_CHROME_HEIGHT = 10;
// MenuSeparator: a 1px rule with 4px above and below.
const SURFACE_MENU_SEPARATOR_HEIGHT = 9;

/**
 * How the menu window is painted. On macOS it sits on native vibrancy, which
 * blurs what is behind the window the way `dropdown-glass` blurs behind T3's
 * menus, under the same translucent tint. Elsewhere a page cannot blur the
 * desktop behind its window, so the menu uses the opaque popover color.
 */
export type RemoteAppSurfaceMenuMaterial = "vibrancy" | "opaque";

/** T3 heads the menu and is ruled off from the sites, as in T3's own menus. */
const hasSurfaceMenuSeparator = (surfaces: ReadonlyArray<DesktopSurface>): boolean =>
  surfaces[0] === "t3code" && surfaces.length > 1;

export const resolveRemoteAppSurfaceMenuHeight = (
  surfaces: ReadonlyArray<DesktopSurface>,
): number =>
  SURFACE_MENU_CHROME_HEIGHT +
  SURFACE_MENU_ITEM_HEIGHT * surfaces.length +
  (hasSurfaceMenuSeparator(surfaces) ? SURFACE_MENU_SEPARATOR_HEIGHT : 0);

const resolveSurfaceMenuTheme = (input: RemoteAppTheme) => {
  const theme = normalizeRemoteAppTheme(input);
  return { appearance: theme.appearance, menu: theme.menu ?? fallbackMenuTheme(theme.colors) };
};

const OPAQUE_HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** The native window background behind the opaque menu, so it never flashes. */
export const resolveRemoteAppSurfaceMenuBackground = (input: RemoteAppTheme): string => {
  const { menu } = resolveSurfaceMenuTheme(input);
  if (OPAQUE_HEX_COLOR.test(menu.popover)) return menu.popover;
  const { surfaceOverlay } = normalizeRemoteAppTheme(input).colors;
  return OPAQUE_HEX_COLOR.test(surfaceOverlay)
    ? surfaceOverlay
    : DEFAULT_REMOTE_APP_THEME.colors.surfaceOverlay;
};

const surfaceLabel = (surface: DesktopSurface): string =>
  surface === "t3code" ? PRODUCT_NAME : REMOTE_APP_SITE_INFO[surface].label;

export const buildRemoteAppSurfaceMenuHtml = (
  input: RemoteAppTheme,
  surfaces: ReadonlyArray<DesktopSurface>,
  material: RemoteAppSurfaceMenuMaterial,
  // Sites that finished a reply while hidden; their rows carry a static dot.
  unreadSurfaces: ReadonlyArray<DesktopSurface> = [],
): string => {
  const { appearance, menu } = resolveSurfaceMenuTheme(input);
  const unreadColor = normalizeRemoteAppTheme(input).colors.focus;
  const separated = hasSurfaceMenuSeparator(surfaces);
  const items = surfaces
    .map((surface, index) => {
      const separator =
        separated && index === 1 ? '\n      <div class="separator" role="separator"></div>' : "";
      const unread = unreadSurfaces.includes(surface);
      const label = surfaceLabel(surface);
      const item = `
      <a role="menuitem" class="item" href="${surfaceMenuUrl(surface)}"${
        unread ? ` aria-label="${label}, finished reply"` : ""
      }>
        <span class="icon">${REMOTE_APP_SURFACE_ICONS[surface]}</span>
        <span class="label">${label}</span>${unread ? '\n        <span class="unread"></span>' : ""}
      </a>`;
      if (surface === "t3code") return `${separator}${item}`;
      // A site row also opens the site beside the current thread.
      return `${separator}
      <div class="row">${item}
        <a role="menuitem" class="panel" href="t3code-surface://panel/${surface}" aria-label="Open ${label} in Side Panel" title="Open in Side Panel">${SIDE_PANEL_ICON}</a>
      </div>`;
    })
    .join("");
  // The native window clips the corners (roundedCorners) and draws the shadow.
  // On vibrancy the popup repeats T3's 10px radius so its border follows the
  // rounded glass; an opaque window is clipped by the platform alone.
  const radius = material === "vibrancy" ? "10px" : "0";
  return `<!doctype html>
<html lang="en" data-theme="${appearance}">
  <head>
    <meta charset="utf-8">
    <style>
      :root { color-scheme: ${appearance}; }
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
      body {
        color: ${menu.foreground};
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        -webkit-font-smoothing: antialiased;
        user-select: none;
      }
      [role="menu"] {
        height: 100%;
        padding: 4px;
        border: 1px solid ${menu.border};
        border-radius: ${radius};
        background: ${material === "vibrancy" ? menu.glass : menu.popover};
      }
      [role="menuitem"] {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 28px;
        padding: 4px 8px;
        border-radius: 6px;
        color: ${menu.foreground};
        font-size: 14px;
        line-height: 20px;
        text-decoration: none;
        outline: none;
        cursor: pointer;
      }
      /* Focus is the highlight: pointer movement and arrow keys both move it. */
      [role="menuitem"]:focus {
        background: ${menu.highlight};
        color: ${menu.highlightForeground};
      }
      .icon {
        display: inline-flex;
        flex: none;
        width: 16px;
        height: 16px;
        margin-inline: -2px;
      }
      .icon svg { width: 16px; height: 16px; }
      .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .separator { height: 1px; margin: 4px 8px; background: ${menu.separator}; }
      /* The side-panel button overlays the row's end, over its unread dot, and
         shows only while the row is hovered or focused. */
      .row { position: relative; }
      .panel {
        position: absolute;
        inset-block: 0;
        inset-inline-end: 0;
        justify-content: center;
        width: 28px;
        padding: 0;
        color: ${menu.mutedForeground};
        opacity: 0;
      }
      .panel svg { width: 16px; height: 16px; }
      .row:hover .panel, .row:focus-within .panel { opacity: 1; }
      .row:hover .unread, .row:focus-within .unread { visibility: hidden; }
      .unread {
        flex: none;
        width: 6px;
        height: 6px;
        margin-inline-start: auto;
        border-radius: 9999px;
        background: ${unreadColor};
      }
    </style>
  </head>
  <body>
    <div role="menu" aria-label="Switch app surface">${items}
    </div>
    <script>
      // Up and down move between surfaces; right and left between a site and
      // its side-panel button.
      const all = Array.from(document.querySelectorAll('[role="menuitem"]'));
      const items = all.filter((item) => item.classList.contains("item"));
      const focusAt = (index) => items[(index + items.length) % items.length]?.focus();
      for (const item of all) {
        item.addEventListener("mousemove", () => item.focus());
        item.addEventListener("mouseleave", () => item.blur());
      }
      document.addEventListener("keydown", (event) => {
        const active = document.activeElement;
        const row = active?.closest(".row");
        const index = items.indexOf(row ? row.querySelector(".item") : active);
        if (event.key === "ArrowDown") focusAt(index + 1);
        else if (event.key === "ArrowUp") focusAt(index < 0 ? items.length - 1 : index - 1);
        else if (event.key === "Home") focusAt(0);
        else if (event.key === "End") focusAt(items.length - 1);
        else if (event.key === "ArrowRight" && row) row.querySelector(".panel")?.focus();
        else if (event.key === "ArrowLeft" && row) row.querySelector(".item")?.focus();
        else if (event.key === "Enter" || event.key === " ") {
          if (all.includes(active)) active.click();
        }
        else if (event.key === "Escape") window.location.href = "t3code-surface://close";
        else return;
        event.preventDefault();
      });
    </script>
  </body>
</html>`;
};
