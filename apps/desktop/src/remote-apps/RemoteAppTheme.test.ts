import { RemoteAppThemeSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRemoteAppInteractionScript,
  buildRemoteAppSurfaceMenuHtml,
  buildRemoteAppThemeCss,
  DEFAULT_REMOTE_APP_THEME,
  isChatGptRemoteAppUrl,
  normalizeRemoteAppTheme,
  resolveRemoteToolbarControlKind,
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
    expect(css).toContain("--composer-surface: var(--t3code-remote-input) !important");
    expect(css).toContain('[data-t3code-remote-composer-shell="true"]');
    expect(css).toContain("background: var(--t3code-remote-input) !important");
    expect(css).toContain("[data-t3code-remote-toolbar-control]");
    expect(css).not.toContain("form:has(textarea)");
    expect(css).not.toContain("width: nullpx");

    const alignedCss = buildRemoteAppThemeCss({
      ...DEFAULT_REMOTE_APP_THEME,
      sidebarWidth: 235,
    });
    expect(alignedCss).toContain("width: 235px !important");
    expect(alignedCss).toContain("--sidebar-width: 235px !important");
    expect(alignedCss).toContain('[data-testid*="sidebar"]');
    expect(alignedCss).toContain("main :where(a)");
    expect(alignedCss).toContain("html body :is(");
    expect(alignedCss).toContain("background-image: none !important");
    expect(alignedCss).toContain('[data-t3code-remote-sidebar="true"]');
    expect(alignedCss).toContain('[data-t3code-remote-sidebar-root="true"]');
    expect(alignedCss).not.toContain("flex-basis: 235px !important");
    expect(alignedCss).toContain("overflow-x: hidden !important");
    expect(alignedCss).toContain("padding-top: 9px !important");
    expect(alignedCss).toContain("transform: translateY(-40px) !important");
    expect(alignedCss).not.toContain("\n:where(a) {");
  });

  it("validates stage-art variants and defaults unknown presentation input", () => {
    const decodeTheme = Schema.decodeUnknownSync(RemoteAppThemeSchema);

    expect(decodeTheme(DEFAULT_REMOTE_APP_THEME).stageArt).toBe("none");
    expect(() => decodeTheme({ ...DEFAULT_REMOTE_APP_THEME, stageArt: "preview" })).toThrow();
    expect(
      normalizeRemoteAppTheme({
        ...DEFAULT_REMOTE_APP_THEME,
        stageArt: "preview" as never,
      }).stageArt,
    ).toBe("none");
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
    const script = buildRemoteAppInteractionScript({
      ...DEFAULT_REMOTE_APP_THEME,
      stageArt: "nightly",
    });

    expect(script).toContain("__t3codeRemoteAppInteraction");
    expect(script).toContain("targetSidebarWidth");
    expect(script).toContain("dataset.t3codeRemoteSidebar");
    expect(script).toContain("dataset.t3codeRemoteSidebarRoot");
    expect(script).toContain("style.removeProperty(property)");
    expect(script).toContain("getBoundingClientRect().height >=");
    expect(script).toContain("existing.setPresentation(");
    expect(script).toContain("setPresentation(value, stageArt, stageMarkup)");
    expect(script).toContain('setProperty("overflow-x", "hidden", "important")');
    expect(script).not.toContain('rootSidebar.querySelectorAll("*")');
    expect(script).toContain("requestAnimationFrame");
    expect(script).toContain("textarea, [contenteditable='true']");
    expect(script).toContain("dataset.t3codeRemoteComposerShell");
    expect(script).toContain("dataset.t3codeRemoteComposerEditable");
    expect(script).toContain("dataset.t3codeRemoteToolbarControl");
    expect(script).toContain("data-t3code-remote-stage-art");
    expect(script).toContain("stage-nightly");
    expect(script).toContain("button[aria-label*='Add files']");
    expect(script).toContain("[data-state='open']");
    expect(script).toContain("triggerIsOpen");
    expect(script).toContain("dispatchEscape");
    expect(script).toContain('key: "Escape"');
    expect(script).toContain("window.setTimeout(focus, 160)");
    expect(script).toContain("queueMicrotask(focus)");
    expect(script).toContain('["pointerdown", "mousedown"');
    expect(script).not.toContain("fetch(");
    expect(script).not.toContain("localStorage");
    expect(() => Function(script)).not.toThrow();
  });

  it("identifies only main-content upper-right ChatGPT toolbar controls", () => {
    const base = {
      insideMainContent: true,
      left: 900,
      top: 24,
      viewportWidth: 1200,
      sidebarWidth: 240,
    };

    expect(resolveRemoteToolbarControlKind({ ...base, accessibleName: "Upgrade" })).toBe("upgrade");
    expect(resolveRemoteToolbarControlKind({ ...base, accessibleName: "Temporary Chat" })).toBe(
      "temporary-chat",
    );
    expect(
      resolveRemoteToolbarControlKind({
        ...base,
        accessibleName: "Upgrade",
        insideMainContent: false,
      }),
    ).toBeNull();
    expect(
      resolveRemoteToolbarControlKind({ ...base, accessibleName: "Upgrade", left: 120 }),
    ).toBeNull();
    expect(resolveRemoteToolbarControlKind({ ...base, accessibleName: "Upgrade plan" })).toBeNull();
  });

  it("builds a self-contained themed surface picker with one active option", () => {
    const html = buildRemoteAppSurfaceMenuHtml(DEFAULT_REMOTE_APP_THEME, "chatgpt");

    expect(html).toContain('role="menu" aria-label="Switch app surface"');
    expect(html).toContain('aria-checked="false" href="t3code-surface://select/t3code"');
    expect(html).toContain('aria-checked="true" href="t3code-surface://select/chatgpt"');
    expect(html).toContain("#344653");
    expect(html).not.toContain("<script src=");
  });
});
