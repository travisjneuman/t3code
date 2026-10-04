import type { RemoteAppMenuTheme, RemoteAppThemeColors } from "@t3tools/contracts";

import { useEffect, useRef } from "react";

import {
  getStandardThemeColors,
  getThemeColorVariable,
  getThemeColorsForMode,
  getThemeDefinition,
  resolveThemeHalf,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeHalves,
  type ThemePreference,
} from "../themePalette";
import { THEME_CHANGE_EVENT, useTheme } from "../hooks/useTheme";
import { useEnvironmentIdentificationMode } from "../hooks/useSettings";
import { useSidebarStageBackdropVariant } from "../components/SidebarStageBackdrop";
import { useRemoteAppState } from "./useRemoteAppState";

const REMOTE_THEME_ROLES = [
  "canvas",
  "sidebar",
  "sidebarForeground",
  "sidebarMutedForeground",
  "sidebarRowHover",
  "sidebarRowSelected",
  "sidebarBorder",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "text",
  "textMuted",
  "muted",
  "mutedForeground",
  "placeholder",
  "border",
  "input",
  "focus",
  "accent",
  "accentForeground",
  "secondary",
  "secondaryForeground",
  "toolbar",
  "toolbarForeground",
  "toolbarBorder",
  "toolbarControl",
  "toolbarControlForeground",
  "toolbarControlHover",
  "messageSurface",
  "messageForeground",
  "messageAction",
  "messageActionForeground",
  "messageActionHover",
  "codeBackground",
  "codeForeground",
] as const satisfies ReadonlyArray<ThemeColorRole>;

const REMOTE_STAGE_COLOR_VARIABLES = {
  stageArtTop: "--stage-art-top",
  stageArtMid: "--stage-art-mid",
  stageArtBottom: "--stage-art-bottom",
  stageArtHighlight: "--stage-art-highlight",
  stageArtSecondary: "--stage-art-secondary",
  stageArtTertiary: "--stage-art-tertiary",
  stageArtLine: "--stage-art-line",
  stageArtCelesteHighlight: "--stage-art-celeste-highlight",
  stageArtCelesteSecondary: "--stage-art-celeste-secondary",
  stageArtVioletHighlight: "--stage-art-violet-highlight",
  stageArtGridLine: "--stage-art-grid-line",
  stageNightTop: "--stage-night-top",
  stageNightMid: "--stage-night-mid",
  stageNightBottom: "--stage-night-bottom",
  stageNightHighlight: "--stage-night-highlight",
  stageNightSecondary: "--stage-night-secondary",
  stageNightTertiary: "--stage-night-tertiary",
  stageNightLine: "--stage-night-line",
  stageNightGlowHighlight: "--stage-night-glow-highlight",
  stageNightGlowSecondary: "--stage-night-glow-secondary",
  stageNightSparkle: "--stage-night-sparkle",
} as const satisfies Readonly<Record<string, `--${string}`>>;

type ComputedRemoteThemeColors = Partial<Record<keyof RemoteAppThemeColors, string>>;

/**
 * Keep renderer-to-main theme updates ordered. Theme changes can arrive in a
 * burst (for example while selecting both halves of an automatic mix), and
 * Electron may finish an older IPC call after a newer one. Only the latest
 * queued payload is allowed to start once the current call settles.
 */
export function enqueueLatestRemoteThemeSync(
  queue: Promise<void>,
  sequence: number,
  latestSequence: () => number,
  sync: () => Promise<void>,
): Promise<void> {
  return queue
    .catch(() => undefined)
    .then(async () => {
      if (sequence !== latestSequence()) return;
      await sync();
    })
    .catch(() => undefined);
}

/**
 * Resolve the remote palette from the tokens currently painted into the
 * native renderer. Those computed values are authoritative because they also
 * include custom-theme edits and the selected light/dark half. The named
 * theme definition is retained as a deterministic fallback for the brief
 * interval before a palette has landed in the document. Computed CSS remains
 * the source for stage artwork (whose channel pigments are declared in
 * index.css).
 */
export function resolveRemoteThemeColors({
  theme,
  resolvedTheme,
  themeHalves,
  computed,
}: {
  readonly theme: ThemePreference;
  readonly resolvedTheme: ThemeAppearance;
  readonly themeHalves: ThemeHalves | null;
  readonly computed?: ComputedRemoteThemeColors;
}): RemoteAppThemeColors {
  const activePreference = resolveThemeHalf(theme, themeHalves, resolvedTheme);
  const definition = getThemeDefinition(activePreference);
  const activeColors = definition
    ? (getThemeColorsForMode(definition, resolvedTheme) ?? definition.colors)
    : // No installed theme means the stock T3 Code palette; the "default"
      // colors are T3 Chat's, which only fill roles omitted by theme files.
      getStandardThemeColors(resolvedTheme);

  return Object.fromEntries([
    ...REMOTE_THEME_ROLES.map(
      (role) => [role, computed?.[role] || activeColors[role] || ""] as const,
    ),
    ...Object.keys(REMOTE_STAGE_COLOR_VARIABLES).map(
      (role) => [role, computed?.[role as keyof RemoteAppThemeColors] ?? ""] as const,
    ),
  ]) as RemoteAppThemeColors;
}

let colorProbe: CanvasRenderingContext2D | null | undefined;

/**
 * Resolves any CSS color (oklch, color-mix, named) to `#rrggbb` or `#rrggbbaa`,
 * so the remote surfaces can derive their own token formats from it.
 */
function toHexColor(value: string): string {
  if (value === "" || value.startsWith("#") || !CSS.supports("color", value)) return value;
  if (colorProbe === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    colorProbe = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (colorProbe === null) return value;
  colorProbe.clearRect(0, 0, 1, 1);
  colorProbe.fillStyle = value;
  colorProbe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = colorProbe.getImageData(0, 0, 1, 1).data;
  const hex = (channel: number) => channel.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${a === 255 ? "" : hex(a)}`;
}

function readRemoteThemeColors(
  theme: ThemePreference,
  resolvedTheme: ThemeAppearance,
  themeHalves: ThemeHalves | null,
): RemoteAppThemeColors {
  const styles = getComputedStyle(document.documentElement);
  const computed = Object.fromEntries([
    ...REMOTE_THEME_ROLES.map(
      (role) => [role, styles.getPropertyValue(getThemeColorVariable(role)).trim()] as const,
    ),
    ...Object.entries(REMOTE_STAGE_COLOR_VARIABLES).map(
      ([role, variable]) => [role, styles.getPropertyValue(variable).trim()] as const,
    ),
  ]) as ComputedRemoteThemeColors;
  const colors = resolveRemoteThemeColors({ theme, resolvedTheme, themeHalves, computed });
  return {
    ...colors,
    ...Object.fromEntries(REMOTE_THEME_ROLES.map((role) => [role, toHexColor(colors[role])])),
  };
}

/**
 * The colors of T3's glass menus (`dropdown-glass` in index.css and MenuItem in
 * components/ui/menu.tsx), resolved here because the native surface menu
 * window cannot load T3's stylesheet. Undefined until the tokens are painted.
 */
function readRemoteMenuTheme(): RemoteAppMenuTheme | undefined {
  const styles = getComputedStyle(document.documentElement);
  const read = (variable: `--${string}`) => styles.getPropertyValue(variable).trim();
  const popover = read("--popover");
  const foreground = read("--foreground");
  if (popover === "" || foreground === "") return undefined;
  const glassOpacity = read("--glass-opacity") || "80%";
  const contrastForeground = read("--contrast-foreground") || foreground;
  return {
    glass: toHexColor(
      `color-mix(in srgb, ${popover} 18%, color-mix(in srgb, ${popover} ${glassOpacity}, transparent))`,
    ),
    popover: toHexColor(popover),
    foreground: toHexColor(foreground),
    mutedForeground: toHexColor(read("--muted-foreground") || foreground),
    highlight: toHexColor(read("--accent") || popover),
    highlightForeground: toHexColor(read("--accent-foreground") || foreground),
    border: toHexColor(`color-mix(in srgb, ${contrastForeground} 10%, transparent)`),
    separator: toHexColor(read("--border") || popover),
  };
}

const sidebarStateOf = (sidebar: HTMLElement) =>
  sidebar.closest<HTMLElement>('[data-slot="sidebar"]');

function readRemoteSidebarWidth(): number | null {
  const sidebar = document.querySelector<HTMLElement>("[data-app-sidebar]");
  // A collapsed offcanvas sidebar keeps its width offscreen; report no sidebar.
  if (sidebar === null || sidebarStateOf(sidebar)?.dataset.state === "collapsed") return null;
  const width = sidebar.getBoundingClientRect().width;
  return Number.isFinite(width) && width >= 160 && width <= 512 ? Math.round(width) : null;
}

/** Keeps the isolated native remote surfaces visually aligned with T3's live palette. */
export function RemoteAppThemeSync() {
  const { bridge, state } = useRemoteAppState();
  const { theme, resolvedTheme, appearanceMode, themeHalves } = useTheme();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageArt =
    useSidebarStageBackdropVariant(environmentIdentificationMode === "artwork") ?? "none";
  const lightThemeHalf = themeHalves?.light ?? "";
  const darkThemeHalf = themeHalves?.dark ?? "";
  const latestThemeRef = useRef<{
    theme: typeof theme;
    resolvedTheme: typeof resolvedTheme;
    stageArt: "none" | "nightly" | "dev";
    themeHalves: typeof themeHalves;
  }>({
    theme,
    resolvedTheme,
    stageArt: stageArt as "none" | "nightly" | "dev",
    themeHalves,
  });
  latestThemeRef.current = {
    theme,
    resolvedTheme,
    stageArt: stageArt as "none" | "nightly" | "dev",
    themeHalves,
  };
  const syncSequenceRef = useRef(0);
  const syncQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    if (bridge === undefined) return;
    let disposed = false;
    let pendingThemeFrame: number | null = null;
    const sync = () => {
      if (disposed) return;
      const sequence = ++syncSequenceRef.current;
      syncQueueRef.current = enqueueLatestRemoteThemeSync(
        syncQueueRef.current,
        sequence,
        () => syncSequenceRef.current,
        async () => {
          try {
            // Read only after this sequence reaches the head of the queue.
            // React and the root-token repaint can settle between scheduling
            // and execution; capturing the payload earlier could reapply the
            // previous theme after a newer selection.
            const latestTheme = latestThemeRef.current;
            const renderedAppearance = document.documentElement.classList.contains("dark")
              ? "dark"
              : "light";
            const menu = readRemoteMenuTheme();
            const payload = {
              appearance: renderedAppearance,
              stageArt: latestTheme.stageArt,
              sidebarWidth: readRemoteSidebarWidth(),
              colors: readRemoteThemeColors(
                latestTheme.theme,
                renderedAppearance,
                latestTheme.themeHalves,
              ),
              ...(menu === undefined ? {} : { menu }),
            } as const;
            await bridge.setTheme(payload);
          } catch (cause: unknown) {
            console.error("Failed to sync the T3 theme to the isolated remote surfaces.", cause);
          }
        },
      );
    };

    // Theme selection paints the root tokens before React publishes the new
    // external-store snapshot. Defer the boundary reaction until that paint
    // so the queued payload sees both the freshly rendered tokens and the
    // latest theme-half selection.
    const syncAfterThemePaint = () => {
      if (pendingThemeFrame !== null) return;
      const run = () => {
        pendingThemeFrame = null;
        sync();
      };
      if (typeof window.requestAnimationFrame === "function") {
        pendingThemeFrame = window.requestAnimationFrame(run);
      } else {
        window.setTimeout(run, 0);
      }
    };

    sync();
    let observedSidebar: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const collapseObserver = new MutationObserver(sync);
    const observeSidebar = () => {
      const sidebar = document.querySelector<HTMLElement>("[data-app-sidebar]");
      if (sidebar === observedSidebar) return;
      resizeObserver?.disconnect();
      collapseObserver.disconnect();
      observedSidebar = sidebar;
      if (sidebar === null) {
        resizeObserver = null;
        return;
      }
      resizeObserver = new ResizeObserver(sync);
      resizeObserver.observe(sidebar);
      const stateHolder = sidebarStateOf(sidebar);
      if (stateHolder !== null) {
        collapseObserver.observe(stateHolder, {
          attributes: true,
          attributeFilter: ["data-state"],
        });
      }
      sync();
    };

    const mutationObserver = new MutationObserver(observeSidebar);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    const themeObserver = new MutationObserver(sync);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    observeSidebar();
    window.addEventListener(THEME_CHANGE_EVENT, syncAfterThemePaint);
    window.addEventListener("resize", sync);
    return () => {
      disposed = true;
      // Invalidate work queued by this effect before a later theme/surface
      // snapshot starts its own synchronization.
      syncSequenceRef.current += 1;
      mutationObserver.disconnect();
      themeObserver.disconnect();
      resizeObserver?.disconnect();
      collapseObserver.disconnect();
      if (pendingThemeFrame !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(pendingThemeFrame);
      }
      pendingThemeFrame = null;
      window.removeEventListener(THEME_CHANGE_EVENT, syncAfterThemePaint);
      window.removeEventListener("resize", sync);
    };
  }, [
    appearanceMode,
    bridge,
    darkThemeHalf,
    lightThemeHalf,
    resolvedTheme,
    stageArt,
    state.activeSurface,
    theme,
  ]);

  return null;
}
