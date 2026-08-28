import type { RemoteAppThemeColors } from "@t3tools/contracts";

import { useEffect } from "react";

import { getThemeColorVariable, type ThemeColorRole } from "../themePalette";
import { useTheme } from "../hooks/useTheme";
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
  "messageSurface",
  "messageForeground",
  "messageAction",
  "messageActionForeground",
  "messageActionHover",
  "codeBackground",
  "codeForeground",
] as const satisfies ReadonlyArray<ThemeColorRole>;

function readRemoteThemeColors(): RemoteAppThemeColors {
  const styles = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    REMOTE_THEME_ROLES.map((role) => [
      role,
      styles.getPropertyValue(getThemeColorVariable(role)).trim(),
    ]),
  ) as RemoteAppThemeColors;
}

/** Keeps the isolated native ChatGPT surface visually aligned with T3's live palette. */
export function RemoteAppThemeSync() {
  const { bridge } = useRemoteAppState();
  const { theme, resolvedTheme, appearanceMode, themeHalves } = useTheme();
  const lightThemeHalf = themeHalves?.light ?? "";
  const darkThemeHalf = themeHalves?.dark ?? "";

  useEffect(() => {
    if (bridge === undefined) return;
    void bridge
      .setTheme({
        appearance: resolvedTheme,
        colors: readRemoteThemeColors(),
      })
      .catch((cause: unknown) => {
        console.error("Failed to sync the T3 theme to the isolated ChatGPT surface.", cause);
      });
  }, [appearanceMode, bridge, darkThemeHalf, lightThemeHalf, resolvedTheme, theme]);

  return null;
}
