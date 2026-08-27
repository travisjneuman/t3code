import { describe, expect, it } from "vite-plus/test";

import {
  resolveRemoteAppZoomFactor,
  shouldAutomaticallyRecoverRenderer,
} from "./RemoteAppManager.ts";

describe("RemoteAppManager", () => {
  it("clamps zoom and permits only one automatic renderer recovery", () => {
    expect(resolveRemoteAppZoomFactor(1, 0.1)).toBe(1.1);
    expect(resolveRemoteAppZoomFactor(0.5, -0.1)).toBe(0.5);
    expect(resolveRemoteAppZoomFactor(3, 0.1)).toBe(3);
    expect(resolveRemoteAppZoomFactor(2, null)).toBe(1);
    expect(shouldAutomaticallyRecoverRenderer(0)).toBe(true);
    expect(shouldAutomaticallyRecoverRenderer(1)).toBe(false);
  });
});
