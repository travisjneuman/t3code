import type { ConfirmDialogOptions, DesktopBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const requestConfirmDialogMock =
  vi.fn<(message: string, options?: ConfirmDialogOptions) => Promise<boolean> | undefined>();

vi.mock("../confirmDialog", () => ({
  requestConfirmDialog: requestConfirmDialogMock,
}));

function testWindow(): Window & typeof globalThis {
  return globalThis.window ?? (globalThis as unknown as Window & typeof globalThis);
}

function installBridge(activeSurface: string, nativeConfirm: () => Promise<boolean>) {
  const getState = vi.fn().mockResolvedValue({ activeSurface });
  testWindow().desktopBridge = {
    confirm: nativeConfirm,
    remoteApps: { getState },
  } as unknown as DesktopBridge;
  return getState;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  if (globalThis.window === undefined) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
  }
  Reflect.deleteProperty(testWindow(), "desktopBridge");
});

afterEach(() => {
  Reflect.deleteProperty(testWindow(), "desktopBridge");
  vi.restoreAllMocks();
});

describe("confirmation above a remote app", () => {
  it("uses native confirmation above the remote ChatGPT surface", async () => {
    const nativeConfirm = vi.fn().mockResolvedValue(true);
    const getState = installBridge("chatgpt", nativeConfirm);
    const { createLocalApi } = await import("../localApi");

    await expect(createLocalApi().dialogs.confirm("Install update?")).resolves.toBe(true);
    expect(getState).toHaveBeenCalledOnce();
    expect(nativeConfirm).toHaveBeenCalledWith("Install update?");
    expect(requestConfirmDialogMock).not.toHaveBeenCalled();
  });

  it("keeps the themed confirmation host while T3 is showing", async () => {
    requestConfirmDialogMock.mockResolvedValue(true);
    const nativeConfirm = vi.fn().mockResolvedValue(false);
    installBridge("t3code", nativeConfirm);
    const { createLocalApi } = await import("../localApi");

    await expect(createLocalApi().dialogs.confirm("Install update?")).resolves.toBe(true);
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(requestConfirmDialogMock).toHaveBeenCalledWith("Install update?", undefined);
  });
});
