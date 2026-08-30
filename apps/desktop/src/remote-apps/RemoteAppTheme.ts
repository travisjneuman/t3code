import {
  REMOTE_APP_THEME_STAGE_COLOR_MAX_LENGTH,
  type DesktopSurface,
  type RemoteAppTheme,
  type RemoteAppThemeColors,
} from "@t3tools/contracts";
import { buildSidebarStageArtworkSvg } from "@t3tools/shared/sidebarStageArtwork";

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

export const normalizeRemoteAppTheme = (theme: RemoteAppTheme): RemoteAppTheme => ({
  appearance: theme.appearance === "light" ? "light" : "dark",
  stageArt: theme.stageArt === "nightly" || theme.stageArt === "dev" ? theme.stageArt : "none",
  sidebarWidth:
    theme.sidebarWidth === null || !Number.isFinite(theme.sidebarWidth)
      ? null
      : Math.min(512, Math.max(160, Math.round(theme.sidebarWidth))),
  colors: Object.fromEntries(
    COLOR_KEYS.map((key) => [
      key,
      safeColor(
        theme.colors[key],
        DEFAULT_REMOTE_APP_THEME.colors[key],
        key.startsWith("stage") ? REMOTE_APP_THEME_STAGE_COLOR_MAX_LENGTH : undefined,
      ),
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

export type RemoteToolbarControlKind = "upgrade" | "temporary-chat";

export type RemoteToolbarControlCandidate = Readonly<{
  accessibleName: string;
  insideMainContent: boolean;
  left: number;
  top: number;
  viewportWidth: number;
  sidebarWidth: number | null;
}>;

/** Keeps identically named account/sidebar actions outside the host toolbar palette. */
export function resolveRemoteToolbarControlKind(
  candidate: RemoteToolbarControlCandidate,
): RemoteToolbarControlKind | null {
  if (!candidate.insideMainContent) return null;
  const accessibleName = candidate.accessibleName.trim().replace(/\s+/g, " ").toLowerCase();
  const kind =
    accessibleName === "upgrade"
      ? "upgrade"
      : accessibleName === "temporary chat"
        ? "temporary-chat"
        : null;
  if (kind === null || candidate.top < 0 || candidate.top > 160) return null;
  const contentBoundary = candidate.sidebarWidth ?? candidate.viewportWidth * 0.45;
  return candidate.left >= contentBoundary ? kind : null;
}

/**
 * Restores the native site's expected editor focus after its add-files popover
 * dismisses. The handler is limited to editable controls and is installed in
 * the remote document, so it cannot affect the T3 renderer or other origins.
 */
export const buildRemoteAppInteractionScript = (
  input: RemoteAppTheme = DEFAULT_REMOTE_APP_THEME,
): string => {
  const { sidebarWidth, colors } = normalizeRemoteAppTheme(input);
  const inlineThemeVariables = JSON.stringify({
    "--t3code-remote-canvas": colors.canvas,
    "--t3code-remote-sidebar": colors.sidebar,
    "--t3code-remote-sidebar-foreground": colors.sidebarForeground,
    "--t3code-remote-sidebar-muted-foreground": colors.sidebarMutedForeground,
    "--t3code-remote-sidebar-row-hover": colors.sidebarRowHover,
    "--t3code-remote-sidebar-row-selected": colors.sidebarRowSelected,
    "--t3code-remote-sidebar-border": colors.sidebarBorder,
    "--t3code-remote-surface": colors.surface,
    "--t3code-remote-surface-raised": colors.surfaceRaised,
    "--t3code-remote-surface-overlay": colors.surfaceOverlay,
    "--t3code-remote-text": colors.text,
    "--t3code-remote-text-muted": colors.textMuted,
    "--t3code-remote-muted": colors.muted,
    "--t3code-remote-muted-foreground": colors.mutedForeground,
    "--t3code-remote-placeholder": colors.placeholder,
    "--t3code-remote-border": colors.border,
    "--t3code-remote-input": colors.input,
    "--t3code-remote-focus": colors.focus,
    "--t3code-remote-accent": colors.accent,
    "--t3code-remote-accent-foreground": colors.accentForeground,
    "--t3code-remote-secondary": colors.secondary,
    "--t3code-remote-secondary-foreground": colors.secondaryForeground,
    "--t3code-remote-toolbar": colors.toolbar,
    "--t3code-remote-toolbar-foreground": colors.toolbarForeground,
    "--t3code-remote-toolbar-border": colors.toolbarBorder,
    "--t3code-remote-toolbar-control": colors.toolbarControl,
    "--t3code-remote-toolbar-control-foreground": colors.toolbarControlForeground,
    "--t3code-remote-toolbar-control-hover": colors.toolbarControlHover,
    "--main-surface-primary": colors.canvas,
    "--main-surface-secondary": colors.surfaceRaised,
    "--main-surface-tertiary": colors.surfaceRaised,
    "--composer-surface": colors.input,
    "--composer-surface-primary": colors.input,
    "--composer-surface-secondary": colors.input,
    "--sidebar-surface-primary": colors.sidebar,
    "--sidebar-surface-secondary": colors.sidebar,
    "--text-primary": colors.text,
    "--text-secondary": colors.textMuted,
    "--text-tertiary": colors.mutedForeground,
    "--border-light": colors.border,
    "--border-medium": colors.border,
    "--border-heavy": colors.border,
    "--interactive-bg-secondary-hover": colors.sidebarRowHover,
    "--stage-art-top": colors.stageArtTop,
    "--stage-art-mid": colors.stageArtMid,
    "--stage-art-bottom": colors.stageArtBottom,
    "--stage-art-highlight": colors.stageArtHighlight,
    "--stage-art-secondary": colors.stageArtSecondary,
    "--stage-art-tertiary": colors.stageArtTertiary,
    "--stage-art-line": colors.stageArtLine,
    "--stage-art-celeste-highlight": colors.stageArtCelesteHighlight,
    "--stage-art-celeste-secondary": colors.stageArtCelesteSecondary,
    "--stage-art-violet-highlight": colors.stageArtVioletHighlight,
    "--stage-art-grid-line": colors.stageArtGridLine,
    "--stage-night-top": colors.stageNightTop,
    "--stage-night-mid": colors.stageNightMid,
    "--stage-night-bottom": colors.stageNightBottom,
    "--stage-night-highlight": colors.stageNightHighlight,
    "--stage-night-secondary": colors.stageNightSecondary,
    "--stage-night-tertiary": colors.stageNightTertiary,
    "--stage-night-line": colors.stageNightLine,
    "--stage-night-glow-highlight": colors.stageNightGlowHighlight,
    "--stage-night-glow-secondary": colors.stageNightGlowSecondary,
    "--stage-night-sparkle": colors.stageNightSparkle,
  });
  return `
(() => {
  const key = "__t3codeRemoteAppInteraction";
  const nextSidebarWidth = ${sidebarWidth === null ? "null" : Math.round(sidebarWidth)};
  const inlineThemeVariables = ${inlineThemeVariables};
  const applyInlineTheme = () => {
    const root = document.documentElement;
    if (!(root instanceof HTMLElement)) return;
    for (const [property, value] of Object.entries(inlineThemeVariables)) {
      root.style.setProperty(property, value, "important");
    }
  };
  const existing = window[key];
  if (existing && typeof existing.setSidebarWidth === "function") {
    applyInlineTheme();
    existing.setSidebarWidth(nextSidebarWidth);
    return;
  }
  if (existing && typeof existing.setPresentation === "function") {
    applyInlineTheme();
    existing.setPresentation(nextSidebarWidth, "none", "");
    return;
  }
  let targetSidebarWidth = nextSidebarWidth;

  const applySidebarGeometry = () => {
    const utilityHrefs = ["/images", "/library", "/scheduled", "/plugins", "/projects"];
    const sidebarLinks = Array.from(document.querySelectorAll("a[href]")).filter((link) => {
      const href = link.getAttribute("href") ?? "";
      try {
        const pathname = new URL(href, window.location.href).pathname;
        return utilityHrefs.includes(pathname);
      } catch {
        return false;
      }
    });
    // ChatGPT may hide some utility links for a given account or viewport. Two
    // stable utility links are enough to identify the sidebar without relying
    // on a particular account's menu configuration.
    if (sidebarLinks.length < 2) return;

    for (const previousSidebar of document.querySelectorAll(
      "[data-t3code-remote-sidebar='true']",
    )) {
      delete previousSidebar.dataset.t3codeRemoteSidebar;
      delete previousSidebar.dataset.t3codeRemoteSidebarRoot;
      for (const property of ["box-sizing", "width", "min-width", "flex-basis", "overflow-x"]) {
        previousSidebar.style.removeProperty(property);
      }
    }

    const candidates = [];
    let candidate = sidebarLinks[0].parentElement;
    while (candidate instanceof HTMLElement && candidate !== document.body) {
      if (sidebarLinks.every((link) => candidate.contains(link))) {
        const rect = candidate.getBoundingClientRect();
        if (
          rect.left <= 8 &&
          rect.width >= 160 &&
          rect.width <= 512 &&
          rect.height >= 160
        ) {
          candidates.push(candidate);
        }
      }
      candidate = candidate.parentElement;
    }

    let rootSidebar = candidates[0];
    for (const candidate of candidates) {
      if (
        !(rootSidebar instanceof HTMLElement) ||
        candidate.getBoundingClientRect().height >= rootSidebar.getBoundingClientRect().height
      ) {
        rootSidebar = candidate;
      }
    }
    if (rootSidebar instanceof HTMLElement) {
      rootSidebar.dataset.t3codeRemoteSidebar = "true";
      rootSidebar.dataset.t3codeRemoteSidebarRoot = "true";
      rootSidebar.style.setProperty("box-sizing", "border-box", "important");
      if (targetSidebarWidth !== null) {
        rootSidebar.style.setProperty("width", \`\${targetSidebarWidth}px\`, "important");
        rootSidebar.style.setProperty("min-width", \`\${targetSidebarWidth}px\`, "important");
      }
      rootSidebar.style.setProperty("overflow-x", "hidden", "important");
    }
  };

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

  const applyToolbarControlMarkers = () => {
    for (const previous of document.querySelectorAll(
      "[data-t3code-remote-toolbar-control]",
    )) {
      delete previous.dataset.t3codeRemoteToolbarControl;
    }
    const main = document.querySelector("main, [role='main']");
    const contentBoundary = targetSidebarWidth ?? window.innerWidth * 0.45;
    const sidebarSelector =
      "[data-t3code-remote-sidebar-root='true'], nav, [role='complementary'], [data-testid='sidebar'], [data-testid*='sidebar'], aside, [aria-label='Chat history'], [class~='group/sidebar']";
    for (const control of document.querySelectorAll("button, a[role='button']")) {
      if (!(control instanceof HTMLElement) || !isVisible(control)) continue;
      const accessibleName = (
        control.getAttribute("aria-label") ??
        control.getAttribute("title") ??
        control.textContent ??
        ""
      )
        .trim()
        .replace(/\\s+/g, " ")
        .toLowerCase();
      const kind =
        accessibleName === "upgrade"
          ? "upgrade"
          : accessibleName === "temporary chat"
            ? "temporary-chat"
            : null;
      const rect = control.getBoundingClientRect();
      const insideSidebar = control.closest(sidebarSelector) !== null;
      const insideMainContent = main instanceof HTMLElement && main.contains(control);
      const inUpperRightContent =
        !insideSidebar && (insideMainContent || rect.left >= contentBoundary);
      if (
        kind === null ||
        !inUpperRightContent ||
        rect.left < contentBoundary ||
        rect.top < 0 ||
        rect.top > 160
      )
        continue;
      control.dataset.t3codeRemoteToolbarControl = kind;
    }
  };

  const applyAuthMarkers = () => {
    const root = document.documentElement;
    if (!(root instanceof HTMLElement)) return;
    delete root.dataset.t3codeRemoteAuth;
    for (const previous of document.querySelectorAll(
      "[data-t3code-remote-auth-control], [data-t3code-remote-auth-primary]",
    )) {
      delete previous.dataset.t3codeRemoteAuthControl;
      delete previous.dataset.t3codeRemoteAuthPrimary;
    }

    const isAuthHeading = Array.from(
      document.querySelectorAll("h1, h2, h3, [role='heading']"),
    ).some(
      (heading) =>
        heading.textContent?.trim().replace(/\\s+/g, " ").toLowerCase() === "log in or sign up",
    );
    if (!isAuthHeading) return;
    root.dataset.t3codeRemoteAuth = "true";

    const main = document.querySelector("main, [role='main']");
    if (!(main instanceof HTMLElement)) return;
    for (const control of main.querySelectorAll("button, [role='button']")) {
      if (!(control instanceof HTMLElement) || !isVisible(control)) continue;
      const accessibleName = (
        control.getAttribute("aria-label") ??
        control.getAttribute("title") ??
        control.textContent ??
        ""
      )
        .trim()
        .replace(/\\s+/g, " ")
        .toLowerCase();
      if (accessibleName === "continue" || control.getAttribute("type") === "submit") {
        control.dataset.t3codeRemoteAuthPrimary = "true";
      } else if (accessibleName.startsWith("continue with ")) {
        control.dataset.t3codeRemoteAuthControl = "true";
      }
    }
  };

  const applySemanticMarkers = () => {
    applyComposerMarkers();
    applyToolbarControlMarkers();
    applyAuthMarkers();
  };
  let geometryFrame = 0;
  const scheduleSidebarGeometry = () => {
    if (geometryFrame !== 0) return;
    geometryFrame = window.requestAnimationFrame(() => {
      geometryFrame = 0;
      applySidebarGeometry();
    });
  };
  let semanticTimer = 0;
  const scheduleSemanticMarkers = () => {
    if (semanticTimer !== 0) return;
    semanticTimer = window.setTimeout(() => {
      semanticTimer = 0;
      applySemanticMarkers();
    }, 80);
  };
  applyInlineTheme();
  applySidebarGeometry();
  applySemanticMarkers();
  for (const delay of [0, 120, 500, 1_200, 3_000, 6_000, 10_000]) {
    window.setTimeout(applySidebarGeometry, delay);
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
    const homeLink = Array.from(document.querySelectorAll("a[href]")).find((candidate) => {
      if (!(candidate instanceof HTMLAnchorElement)) return false;
      try {
        const url = new URL(candidate.href, window.location.href);
        return url.hostname === window.location.hostname && url.pathname === "/";
      } catch {
        return false;
      }
    });
    return homeLink instanceof HTMLAnchorElement
      ? homeLink.href
      : new URL("/?slm=1", window.location.origin).href;
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

    // On the login route this link is currently emitted as a hash anchor. Let
    // the site's handler run first, then repair only the exact anonymous-home
    // action when the document is still on an auth path.
    const targetUrl = resolveTryItFirstUrl();
    window.setTimeout(() => {
      try {
        if (new URL(window.location.href).pathname.startsWith("/auth/")) {
          window.location.assign(targetUrl);
        }
      } catch {
        // The remote document may have been replaced while the timer ran.
      }
    }, 0);
  };

  document.addEventListener("click", handleTryItFirst, true);

  for (const eventName of ["pointerdown", "mousedown", "click"]) {
    document.addEventListener(eventName, (event) => focusEditable(event.target), true);
  }
  window[key] = {
    setSidebarWidth(value) {
      targetSidebarWidth = value;
      scheduleSidebarGeometry();
      scheduleSemanticMarkers();
    },
  };
})();
`;
};

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
  const { appearance, stageArt, sidebarWidth, colors } = normalizeRemoteAppTheme(input);
  const colorScheme = appearance === "dark" ? "dark" : "light";
  const sidebarWidthVariable =
    sidebarWidth === null ? "" : `\n  --sidebar-width: ${sidebarWidth}px !important;`;
  const stageArtwork =
    stageArt === "none"
      ? null
      : buildSidebarStageArtworkSvg({
          variant: stageArt,
          idPrefix: "t3code-remote-sidebar-stage",
        })
          .replaceAll("var(--stage-art-top)", colors.stageArtTop)
          .replaceAll("var(--stage-art-mid)", colors.stageArtMid)
          .replaceAll("var(--stage-art-bottom)", colors.stageArtBottom)
          .replaceAll("var(--stage-art-highlight)", colors.stageArtHighlight)
          .replaceAll("var(--stage-art-secondary)", colors.stageArtSecondary)
          .replaceAll("var(--stage-art-tertiary)", colors.stageArtTertiary)
          .replaceAll("var(--stage-art-line)", colors.stageArtLine)
          .replaceAll("var(--stage-art-celeste-highlight)", colors.stageArtCelesteHighlight)
          .replaceAll("var(--stage-art-celeste-secondary)", colors.stageArtCelesteSecondary)
          .replaceAll("var(--stage-art-violet-highlight)", colors.stageArtVioletHighlight)
          .replaceAll("var(--stage-art-grid-line)", colors.stageArtGridLine)
          .replaceAll("var(--stage-night-top)", colors.stageNightTop)
          .replaceAll("var(--stage-night-mid)", colors.stageNightMid)
          .replaceAll("var(--stage-night-bottom)", colors.stageNightBottom)
          .replaceAll("var(--stage-night-highlight)", colors.stageNightHighlight)
          .replaceAll("var(--stage-night-secondary)", colors.stageNightSecondary)
          .replaceAll("var(--stage-night-tertiary)", colors.stageNightTertiary)
          .replaceAll("var(--stage-night-line)", colors.stageNightLine)
          .replaceAll("var(--stage-night-glow-highlight)", colors.stageNightGlowHighlight)
          .replaceAll("var(--stage-night-glow-secondary)", colors.stageNightGlowSecondary)
          .replaceAll("var(--stage-night-sparkle)", colors.stageNightSparkle);
  const stageArtworkRule =
    stageArtwork === null
      ? ""
      : `\n  background-image: url("data:image/svg+xml,${encodeURIComponent(stageArtwork)}") !important;\n  background-position: left -40px !important;\n  background-repeat: no-repeat !important;\n  background-size: 100% 80px !important;`;
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
  --t3code-remote-toolbar-control-hover: ${colors.toolbarControlHover};
  --stage-art-top: ${colors.stageArtTop};
  --stage-art-mid: ${colors.stageArtMid};
  --stage-art-bottom: ${colors.stageArtBottom};
  --stage-art-highlight: ${colors.stageArtHighlight};
  --stage-art-secondary: ${colors.stageArtSecondary};
  --stage-art-tertiary: ${colors.stageArtTertiary};
  --stage-art-line: ${colors.stageArtLine};
  --stage-art-celeste-highlight: ${colors.stageArtCelesteHighlight};
  --stage-art-celeste-secondary: ${colors.stageArtCelesteSecondary};
  --stage-art-violet-highlight: ${colors.stageArtVioletHighlight};
  --stage-art-grid-line: ${colors.stageArtGridLine};
  --stage-night-top: ${colors.stageNightTop};
  --stage-night-mid: ${colors.stageNightMid};
  --stage-night-bottom: ${colors.stageNightBottom};
  --stage-night-highlight: ${colors.stageNightHighlight};
  --stage-night-secondary: ${colors.stageNightSecondary};
  --stage-night-tertiary: ${colors.stageNightTertiary};
  --stage-night-line: ${colors.stageNightLine};
  --stage-night-glow-highlight: ${colors.stageNightGlowHighlight};
  --stage-night-glow-secondary: ${colors.stageNightGlowSecondary};
  --stage-night-sparkle: ${colors.stageNightSparkle};
  --main-surface-primary: var(--t3code-remote-canvas) !important;
  --main-surface-secondary: var(--t3code-remote-surface-raised) !important;
  --main-surface-tertiary: var(--t3code-remote-surface-raised) !important;
  --composer-surface: var(--t3code-remote-input) !important;
  --composer-surface-primary: var(--t3code-remote-input) !important;
  --composer-surface-secondary: var(--t3code-remote-input) !important;
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
}

[data-t3code-remote-sidebar="true"] {
  box-sizing: border-box !important;
  width: ${sidebarWidth === null ? "auto" : `${Math.round(sidebarWidth)}px`} !important;
  min-width: ${sidebarWidth === null ? "0" : `${Math.round(sidebarWidth)}px`} !important;
  overflow-x: hidden !important;
}

/* Match the first remote row to the native Search row instead of letting it
   hug the shared titlebar. Only the outer detected sidebar receives this
   inset; nested width containers stay untouched. */
[data-t3code-remote-sidebar-root="true"] {
  position: relative !important;
  padding-top: 9px !important;
  background-color: var(--t3code-remote-sidebar) !important;
${stageArtworkRule}
}

/* ChatGPT nests opaque sidebar wrappers inside the detected outer boundary.
   Keep that outer boundary opaque, but let the nested wrappers reveal its
   canonical stage artwork instead of covering it with the same solid fill. */
[data-t3code-remote-sidebar-root="true"] :where(
  nav,
  [role="complementary"],
  [data-testid="sidebar"],
  [data-testid*="sidebar"],
  aside,
  [aria-label="Chat history"],
  [class~="group/sidebar"],
  [class~="bg-token-sidebar-surface-primary"],
  [class~="bg-token-sidebar-surface-secondary"]
) {
  background-color: transparent !important;
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

/* The semantic outer sidebar remains opaque. Clear only non-interactive
   nested wrapper fills so they cannot cover the canonical stage artwork;
   links and controls retain their own hover, selected, and account states. */
[data-t3code-remote-sidebar-root="true"]
  :where(*):not(a):not(button):not([role="button"]) {
  background-color: transparent !important;
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

[data-t3code-remote-composer-root="true"] {
  background: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
  color: var(--t3code-remote-text) !important;
}

[data-t3code-remote-composer-shell="true"] {
  background: var(--t3code-remote-input) !important;
  border: 1px solid var(--t3code-remote-border) !important;
  box-shadow: 0 1px 0 rgb(255 255 255 / 5%) inset !important;
  color: var(--t3code-remote-text) !important;
}

[data-t3code-remote-composer-shell="true"]:focus-within {
  border-color: var(--t3code-remote-focus) !important;
  box-shadow:
    0 0 0 1px var(--t3code-remote-focus),
    0 1px 0 rgb(255 255 255 / 5%) inset !important;
}

main :where(button, [role="button"]) {
  color: var(--t3code-remote-text) !important;
}

[data-t3code-remote-composer-editable="true"] {
  background: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
  color: var(--t3code-remote-text) !important;
  caret-color: var(--t3code-remote-accent) !important;
  outline: none !important;
}

[data-t3code-remote-composer-editable="true"]::placeholder,
[data-t3code-remote-composer-editable="true"]:empty::before,
[data-t3code-remote-composer-editable="true"] [data-placeholder]::before {
  color: var(--t3code-remote-placeholder) !important;
}

[data-t3code-remote-toolbar-control] {
  background: var(--t3code-remote-toolbar-control) !important;
  border: 1px solid var(--t3code-remote-toolbar-border) !important;
  color: var(--t3code-remote-toolbar-control-foreground) !important;
  box-shadow: none !important;
}

[data-t3code-remote-toolbar-control] :where(*) {
  color: inherit !important;
}

[data-t3code-remote-toolbar-control] :where(svg) {
  color: inherit !important;
}

[data-t3code-remote-toolbar-control]:where(:hover, [data-state="open"]):not(:disabled) {
  background: var(--t3code-remote-toolbar-control-hover) !important;
}

[data-t3code-remote-toolbar-control]:where(
  :active,
  [aria-pressed="true"],
  [data-state="active"],
  [data-state="checked"]
):not(:disabled) {
  background: var(--t3code-remote-sidebar-row-selected) !important;
}

[data-t3code-remote-toolbar-control]:focus-visible {
  outline: 2px solid var(--t3code-remote-focus) !important;
  outline-offset: 2px !important;
  --tw-ring-color: var(--t3code-remote-focus) !important;
}

[data-t3code-remote-toolbar-control]:where(:disabled, [aria-disabled="true"]) {
  cursor: default !important;
  opacity: 0.5 !important;
}

/* The unauthenticated login surface is still ChatGPT's live document, but
   its sign-in controls must not fall back to ChatGPT's separate black/white
   palette. The interaction bridge marks only the visible auth controls, so
   chat buttons and similarly named sidebar/account actions remain untouched. */
:root[data-t3code-remote-auth="true"] [data-t3code-remote-auth-control] {
  background: var(--t3code-remote-secondary) !important;
  border: 1px solid var(--t3code-remote-border) !important;
  color: var(--t3code-remote-secondary-foreground) !important;
}

:root[data-t3code-remote-auth="true"] [data-t3code-remote-auth-control]:hover {
  background: var(--t3code-remote-toolbar-control-hover) !important;
}

:root[data-t3code-remote-auth="true"] [data-t3code-remote-auth-primary] {
  background: var(--t3code-remote-accent) !important;
  border: 1px solid var(--t3code-remote-accent) !important;
  color: var(--t3code-remote-accent-foreground) !important;
}

:root[data-t3code-remote-auth="true"] [data-t3code-remote-auth-primary]:hover {
  background: var(--t3code-remote-toolbar-control-hover) !important;
  border-color: var(--t3code-remote-focus) !important;
}

:root[data-t3code-remote-auth="true"] [data-t3code-remote-auth-control]:focus-visible,
:root[data-t3code-remote-auth="true"] [data-t3code-remote-auth-primary]:focus-visible {
  outline: 2px solid var(--t3code-remote-focus) !important;
  outline-offset: 2px !important;
}

:root[data-t3code-remote-auth="true"] input[type="email"] {
  background: var(--t3code-remote-input) !important;
  border-color: var(--t3code-remote-border) !important;
  color: var(--t3code-remote-text) !important;
  caret-color: var(--t3code-remote-accent) !important;
}

:root[data-t3code-remote-auth="true"] input[type="email"]::placeholder {
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
