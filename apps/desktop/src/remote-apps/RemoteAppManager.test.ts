import { describe, expect, it } from "vite-plus/test";

import {
  parseRemoteAppSurfaceMenuUrl,
  resolveRemoteAppViewBounds,
  resolveRemoteAppViewZoomFactor,
  resolveRemoteAppZoomFactor,
  shouldAutomaticallyRecoverRenderer,
} from "./RemoteAppManager.ts";

describe("RemoteAppManager", () => {
  it("keeps the remote view inside the host titlebar and footer bounds", () => {
    expect(resolveRemoteAppViewBounds({ width: 1200, height: 800 }, 1.5)).toEqual({
      x: 0,
      y: 60,
      width: 1200,
      height: 668,
    });
    expect(resolveRemoteAppViewBounds({ width: 1200, height: 20 }, Number.NaN)).toEqual({
      x: 0,
      y: 40,
      width: 1200,
      height: 0,
    });
  });

  it("uses the native window zoom for remote layout", () => {
    expect(resolveRemoteAppViewZoomFactor(1.2)).toBe(1.2);
    expect(resolveRemoteAppViewZoomFactor(Number.NaN)).toBe(1);
    expect(resolveRemoteAppViewZoomFactor(0)).toBe(1);
  });

  it("clamps zoom and permits only one automatic renderer recovery", () => {
    expect(resolveRemoteAppZoomFactor(1, 0.1)).toBe(1.1);
    expect(resolveRemoteAppZoomFactor(0.5, -0.1)).toBe(0.5);
    expect(resolveRemoteAppZoomFactor(3, 0.1)).toBe(3);
    expect(resolveRemoteAppZoomFactor(2, null)).toBe(1);
    expect(shouldAutomaticallyRecoverRenderer(0)).toBe(true);
    expect(shouldAutomaticallyRecoverRenderer(1)).toBe(false);
  });

  it("accepts only the two internal surface-picker destinations", () => {
    expect(parseRemoteAppSurfaceMenuUrl("t3code-surface://select/t3code")).toBe("t3code");
    expect(parseRemoteAppSurfaceMenuUrl("t3code-surface://select/chatgpt")).toBe("chatgpt");
    expect(parseRemoteAppSurfaceMenuUrl("https://example.com")).toBeUndefined();
    expect(parseRemoteAppSurfaceMenuUrl("t3code-surface://select/chatgpt?external=1")).toBe(
      "chatgpt",
    );
    expect(parseRemoteAppSurfaceMenuUrl("t3code-surface://select/other")).toBeUndefined();
  });
});
