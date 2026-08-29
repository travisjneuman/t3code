import type { RemoteAppThemeColors } from "@t3tools/contracts";

import { useEffect } from "react";

import {
  getDefaultThemeColors,
  getThemeColorVariable,
  getThemeColorsForMode,
  getThemeDefinition,
  resolveThemeHalf,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeHalves,
  type ThemePreference,
} from "../themePalette";
import { useTheme } from "../hooks/useTheme";
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
 * Resolve the remote palette from the same theme definition that paints the
 * native renderer. Computed CSS remains the source for stage artwork (whose
 * channel pigments are declared in index.css), but the ChatGPT surfaces must
 * never fall back to a second, site-specific color scheme when the CSS
 * variables have not landed yet.
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
    : getDefaultThemeColors(resolvedTheme);

  return Object.fromEntries([
    ...REMOTE_THEME_ROLES.map(
      (role) => [role, computed?.[role] || activeColors[role] || ""] as const,
    ),
    ...Object.keys(REMOTE_STAGE_COLOR_VARIABLES).map(
      (role) => [role, computed?.[role as keyof RemoteAppThemeColors] ?? ""] as const,
    ),
  ]) as RemoteAppThemeColors;
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
  return resolveRemoteThemeColors({ theme, resolvedTheme, themeHalves, computed });
}

function readRemoteSidebarWidth(): number | null {
  const sidebar = document.querySelector<HTMLElement>("[data-app-sidebar]");
  if (sidebar === null) return null;
  const width = sidebar.getBoundingClientRect().width;
  return Number.isFinite(width) && width >= 160 && width <= 512 ? Math.round(width) : null;
}

/** Keeps the isolated native ChatGPT surface visually aligned with T3's live palette. */
export function RemoteAppThemeSync() {
  const { bridge, state } = useRemoteAppState();
  const { theme, resolvedTheme, appearanceMode, themeHalves } = useTheme();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageArt =
    useSidebarStageBackdropVariant(environmentIdentificationMode === "artwork") ?? "none";
  const lightThemeHalf = themeHalves?.light ?? "";
  const darkThemeHalf = themeHalves?.dark ?? "";

  useEffect(() => {
    if (bridge === undefined) return;
    const sync = () => {
      void bridge
        .setTheme({
          appearance: resolvedTheme,
          stageArt,
          sidebarWidth: readRemoteSidebarWidth(),
          colors: readRemoteThemeColors(theme, resolvedTheme, themeHalves),
        })
        .catch((cause: unknown) => {
          console.error("Failed to sync the T3 theme to the isolated ChatGPT surface.", cause);
        });
    };

    sync();
    let observedSidebar: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const observeSidebar = () => {
      const sidebar = document.querySelector<HTMLElement>("[data-app-sidebar]");
      if (sidebar === observedSidebar) return;
      resizeObserver?.disconnect();
      observedSidebar = sidebar;
      if (sidebar === null) {
        resizeObserver = null;
        return;
      }
      resizeObserver = new ResizeObserver(sync);
      resizeObserver.observe(sidebar);
      sync();
    };

    const mutationObserver = new MutationObserver(observeSidebar);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    observeSidebar();
    window.addEventListener("resize", sync);
    return () => {
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
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
