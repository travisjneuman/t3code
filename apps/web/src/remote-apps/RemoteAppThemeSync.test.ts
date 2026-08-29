import { describe, expect, it } from "vite-plus/test";

import { getDefaultThemeColors, getThemeColorsForMode, OCEAN_THEME } from "../themePalette";
import { resolveRemoteThemeColors } from "./RemoteAppThemeSync";

describe("remote app theme synchronization", () => {
  it("uses the active T3 palette instead of a ChatGPT-specific fallback", () => {
    const colors = resolveRemoteThemeColors({
      theme: OCEAN_THEME.id,
      resolvedTheme: "dark",
      themeHalves: null,
      computed: {
        canvas: "#192531",
        sidebar: "#1b2a39",
        stageNightTop: "oklch(0.3 0.1 280)",
      },
    });
    const oceanDark = getThemeColorsForMode(OCEAN_THEME, "dark")!;

    expect(colors.canvas).toBe(oceanDark.canvas);
    expect(colors.sidebar).toBe(oceanDark.sidebar);
    expect(colors.stageNightTop).toBe("oklch(0.3 0.1 280)");
  });

  it("follows the selected light/dark theme half", () => {
    const colors = resolveRemoteThemeColors({
      theme: "system",
      resolvedTheme: "dark",
      themeHalves: { dark: OCEAN_THEME.id },
    });

    expect(colors.canvas).toBe(getThemeColorsForMode(OCEAN_THEME, "dark")!.canvas);
  });

  it("uses the T3 default palette when no named theme is installed", () => {
    const colors = resolveRemoteThemeColors({
      theme: "system",
      resolvedTheme: "light",
      themeHalves: null,
      computed: { canvas: "#192531" },
    });

    expect(colors.canvas).toBe(getDefaultThemeColors("light").canvas);
  });
});
