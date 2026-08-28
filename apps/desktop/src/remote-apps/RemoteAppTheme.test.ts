import { describe, expect, it } from "vite-plus/test";

import {
  buildRemoteAppInteractionScript,
  buildRemoteAppThemeCss,
  DEFAULT_REMOTE_APP_THEME,
  isChatGptRemoteAppUrl,
  normalizeRemoteAppTheme,
} from "./RemoteAppTheme.ts";

describe("RemoteAppTheme", () => {
  it("only applies the live-site theme to ChatGPT URLs", () => {
    expect(isChatGptRemoteAppUrl("https://chatgpt.com/")).toBe(true);
    expect(isChatGptRemoteAppUrl("https://chatgpt.com/c/abc")).toBe(true);
    expect(isChatGptRemoteAppUrl("https://auth.openai.com/login")).toBe(false);
    expect(isChatGptRemoteAppUrl("https://chatgpt.com.evil.example/")).toBe(false);
    expect(isChatGptRemoteAppUrl("javascript:alert(1)")).toBe(false);
  });

  it("maps the T3 palette to ChatGPT surface tokens and semantic fallbacks", () => {
    const css = buildRemoteAppThemeCss(DEFAULT_REMOTE_APP_THEME);

    expect(css).toContain("color-scheme: dark !important");
    expect(css).toContain("--main-surface-primary: var(--t3code-remote-canvas) !important");
    expect(css).toContain("--sidebar-surface-primary: var(--t3code-remote-sidebar) !important");
    expect(css).toContain("background-color: var(--t3code-remote-surface-raised) !important");
    expect(css).toContain("form:has(textarea)");
    expect(css).not.toContain("width: nullpx");

    const alignedCss = buildRemoteAppThemeCss({
      ...DEFAULT_REMOTE_APP_THEME,
      sidebarWidth: 235,
    });
    expect(alignedCss).toContain("width: 235px !important");
    expect(alignedCss).toContain("--sidebar-width: 235px !important");
    expect(alignedCss).toContain('[data-testid*="sidebar"]');
    expect(alignedCss).toContain("main :where(a)");
    expect(alignedCss).not.toContain("\n:where(a) {");
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
    expect(buildRemoteAppThemeCss(theme)).not.toContain("example.invalid");
  });

  it("installs a focused-only editor recovery handler for the add-files popover", () => {
    const script = buildRemoteAppInteractionScript();

    expect(script).toContain("__t3codeRemoteAppInteraction");
    expect(script).toContain("textarea, [contenteditable='true']");
    expect(script).toContain("queueMicrotask(focus)");
    expect(script).toContain('document.addEventListener("pointerdown"');
    expect(script).not.toContain("fetch(");
    expect(script).not.toContain("localStorage");
  });
});
