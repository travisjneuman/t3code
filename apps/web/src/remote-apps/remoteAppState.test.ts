import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_REMOTE_APP_STATE,
  isRemoteAppSurface,
  resolveRemoteAppState,
  shouldHideHostWorkspaceChrome,
  shouldAcceptRemoteAppState,
} from "./remoteAppState";

describe("remote app renderer state", () => {
  it("falls back to T3 Code and recognizes only the two surfaces", () => {
    expect(resolveRemoteAppState(undefined)).toEqual(DEFAULT_REMOTE_APP_STATE);
    expect(isRemoteAppSurface("t3code")).toBe(true);
    expect(isRemoteAppSurface("chatgpt")).toBe(true);
    expect(isRemoteAppSurface("preview")).toBe(false);
  });

  it("ignores a late notification for the previously active surface", () => {
    const current = { ...DEFAULT_REMOTE_APP_STATE, activeSurface: "chatgpt" as const };
    const next = { ...DEFAULT_REMOTE_APP_STATE, activeSurface: "t3code" as const };

    expect(shouldAcceptRemoteAppState({ current, next, initialized: true })).toBe(false);
    expect(shouldAcceptRemoteAppState({ current, next, initialized: false })).toBe(true);
    expect(shouldAcceptRemoteAppState({ current, next: current, initialized: true })).toBe(true);
  });

  it("hides host workspace chrome only while the native ChatGPT surface is active", () => {
    expect(shouldHideHostWorkspaceChrome({ bridgeAvailable: true, activeSurface: "chatgpt" })).toBe(
      true,
    );
    expect(shouldHideHostWorkspaceChrome({ bridgeAvailable: true, activeSurface: "t3code" })).toBe(
      false,
    );
    expect(
      shouldHideHostWorkspaceChrome({ bridgeAvailable: false, activeSurface: "chatgpt" }),
    ).toBe(false);
  });
});
