import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_REMOTE_APP_STATE,
  isRemoteAppSurface,
  resolveRemoteAppState,
} from "./remoteAppState";

describe("remote app renderer state", () => {
  it("falls back to T3 Code and recognizes only the two surfaces", () => {
    expect(resolveRemoteAppState(undefined)).toEqual(DEFAULT_REMOTE_APP_STATE);
    expect(isRemoteAppSurface("t3code")).toBe(true);
    expect(isRemoteAppSurface("chatgpt")).toBe(true);
    expect(isRemoteAppSurface("preview")).toBe(false);
  });
});
