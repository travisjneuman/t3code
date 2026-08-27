import { describe, expect, it } from "vite-plus/test";

import {
  resolveRemoteAppViewBounds,
  resolveRemoteAppZoomFactor,
  shouldAutomaticallyRecoverRenderer,
} from "./RemoteAppManager.ts";

describe("RemoteAppManager", () => {
  it("keeps the remote view below the zoomed titlebar", () => {
    expect(resolveRemoteAppViewBounds({ width: 1200, height: 800 }, 1.5)).toEqual({
      x: 0,
      y: 60,
      width: 1200,
      height: 740,
    });
    expect(resolveRemoteAppViewBounds({ width: 1200, height: 20 }, Number.NaN)).toEqual({
      x: 0,
      y: 40,
      width: 1200,
      height: 0,
    });
  });

  it("clamps zoom and permits only one automatic renderer recovery", () => {
    expect(resolveRemoteAppZoomFactor(1, 0.1)).toBe(1.1);
    expect(resolveRemoteAppZoomFactor(0.5, -0.1)).toBe(0.5);
    expect(resolveRemoteAppZoomFactor(3, 0.1)).toBe(3);
    expect(resolveRemoteAppZoomFactor(2, null)).toBe(1);
    expect(shouldAutomaticallyRecoverRenderer(0)).toBe(true);
    expect(shouldAutomaticallyRecoverRenderer(1)).toBe(false);
  });
});
