import { RemoteAppThemeSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRemoteAppInteractionScript,
  DEFAULT_REMOTE_APP_THEME,
  isChatGptRemoteAppUrl,
  normalizeRemoteAppTheme,
} from "./RemoteAppTheme.ts";

const decodeRemoteAppTheme = Schema.decodeUnknownSync(RemoteAppThemeSchema);

describe("RemoteAppTheme", () => {
  it("only applies the live-site theme to ChatGPT URLs", () => {
    expect(isChatGptRemoteAppUrl("https://chatgpt.com/")).toBe(true);
    expect(isChatGptRemoteAppUrl("https://chatgpt.com/c/abc")).toBe(true);
    expect(isChatGptRemoteAppUrl("https://auth.openai.com/login")).toBe(false);
    expect(isChatGptRemoteAppUrl("https://chatgpt.com.evil.example/")).toBe(false);
    expect(isChatGptRemoteAppUrl("javascript:alert(1)")).toBe(false);
  });

  it("validates stage-art variants and defaults unknown presentation input", () => {
    expect(decodeRemoteAppTheme(DEFAULT_REMOTE_APP_THEME).stageArt).toBe("none");
    expect(() =>
      decodeRemoteAppTheme({ ...DEFAULT_REMOTE_APP_THEME, stageArt: "preview" }),
    ).toThrow();
    expect(
      normalizeRemoteAppTheme({
        ...DEFAULT_REMOTE_APP_THEME,
        stageArt: "preview" as never,
      }).stageArt,
    ).toBe("none");
  });

  it("accepts bounded browser-serialized stage color expressions", () => {
    const nestedStageColor =
      "color-mix(in oklch, oklch(0.732079 0.09296 224.414) 55%, " +
      "color-mix(in oklch, oklch(0.461094 0.084904 243.478) 38%, " +
      "oklch(0.227147 0.086086 277.99)))";
    expect(nestedStageColor.length).toBeGreaterThan(128);
    expect(nestedStageColor.length).toBeLessThanOrEqual(512);

    const theme = {
      ...DEFAULT_REMOTE_APP_THEME,
      colors: { ...DEFAULT_REMOTE_APP_THEME.colors, stageNightSecondary: nestedStageColor },
    };

    expect(decodeRemoteAppTheme(theme).colors.stageNightSecondary).toBe(nestedStageColor);
    expect(normalizeRemoteAppTheme(theme).colors.stageNightSecondary).toBe(nestedStageColor);
  });

  it("rejects CSS control characters from renderer-provided theme values", () => {
    const theme = {
      ...DEFAULT_REMOTE_APP_THEME,
      colors: {
        ...DEFAULT_REMOTE_APP_THEME.colors,
        canvas: "#123456; background: url(https://example.invalid/secret)",
      },
    };

    expect(normalizeRemoteAppTheme(theme).colors.canvas).toBe(
      DEFAULT_REMOTE_APP_THEME.colors.canvas,
    );
  });

  it("installs a focused-only editor recovery handler for the add-files popover", () => {
    const script = buildRemoteAppInteractionScript();

    expect(script).toContain("__t3codeRemoteAppInteraction");
    expect(script).not.toContain("style.setProperty");
    expect(script).not.toContain("MutationObserver");
    expect(script).toContain("textarea, [contenteditable='true']");
    expect(script).toContain("dataset.t3codeRemoteComposerShell");
    expect(script).toContain("dataset.t3codeRemoteComposerEditable");
    expect(script).toContain("handleTryItFirst");
    expect(script).toContain('new URL("/", window.location.origin).href');
    expect(script).toContain("button[aria-label*='Add files']");
    expect(script).toContain("dispatchEscape");
    expect(script).toContain("queueMicrotask(focus)");
    expect(script).not.toContain("fetch(");
    expect(script).not.toContain("localStorage");
    expect(() => Function(script)).not.toThrow();
  });
});
