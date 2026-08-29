import { describe, expect, it } from "vite-plus/test";

import { getDefaultThemeColors, getThemeColorsForMode, OCEAN_THEME } from "../themePalette";
import { enqueueLatestRemoteThemeSync, resolveRemoteThemeColors } from "./RemoteAppThemeSync";

describe("remote app theme synchronization", () => {
  it("uses the rendered T3 palette instead of a ChatGPT-specific fallback", () => {
    const colors = resolveRemoteThemeColors({
      theme: OCEAN_THEME.id,
      resolvedTheme: "dark",
      themeHalves: null,
      computed: {
        canvas: getThemeColorsForMode(OCEAN_THEME, "dark")!.canvas,
        sidebar: getThemeColorsForMode(OCEAN_THEME, "dark")!.sidebar,
        stageNightTop: "oklch(0.3 0.1 280)",
      },
    });
    const oceanDark = getThemeColorsForMode(OCEAN_THEME, "dark")!;

    expect(colors.canvas).toBe(oceanDark.canvas);
    expect(colors.sidebar).toBe(oceanDark.sidebar);
    expect(colors.stageNightTop).toBe("oklch(0.3 0.1 280)");
  });

  it("falls back to the shared active definition when CSS tokens have not landed", () => {
    const colors = resolveRemoteThemeColors({
      theme: OCEAN_THEME.id,
      resolvedTheme: "dark",
      themeHalves: null,
      computed: { canvas: "", sidebar: "" },
    });

    expect(colors.canvas).toBe(getThemeColorsForMode(OCEAN_THEME, "dark")!.canvas);
    expect(colors.sidebar).toBe(getThemeColorsForMode(OCEAN_THEME, "dark")!.sidebar);
  });

  it("follows the currently rendered token when the selected theme changes", () => {
    const colors = resolveRemoteThemeColors({
      theme: OCEAN_THEME.id,
      resolvedTheme: "dark",
      themeHalves: null,
      computed: {
        canvas: "oklch(0.245899 0.019144 42.044)",
        sidebar: "oklch(0.293349 0.029554 46.882)",
      },
    });

    expect(colors.canvas).toBe("oklch(0.245899 0.019144 42.044)");
    expect(colors.sidebar).toBe("oklch(0.293349 0.029554 46.882)");
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
      computed: { canvas: "" },
    });

    expect(colors.canvas).toBe(getDefaultThemeColors("light").canvas);
  });

  it("coalesces queued IPC work so an older palette cannot finish last", async () => {
    let latest = 1;
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const applied: number[] = [];

    const firstQueued = enqueueLatestRemoteThemeSync(
      Promise.resolve(),
      1,
      () => latest,
      async () => {
        applied.push(1);
        await first;
      },
    );
    latest = 2;
    const secondQueued = enqueueLatestRemoteThemeSync(
      firstQueued,
      2,
      () => latest,
      async () => {
        applied.push(2);
      },
    );

    resolveFirst?.();
    await secondQueued;

    expect(applied).toEqual([2]);
  });
});
