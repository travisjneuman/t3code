import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_REMOTE_APP_STATE, normalizeRemoteAppState } from "./RemoteAppStateStore.ts";

describe("RemoteAppStateStore", () => {
  it("drops credentials, auth callbacks, unsafe recents, and unbounded metadata", () => {
    const normalized = normalizeRemoteAppState({
      ...DEFAULT_REMOTE_APP_STATE,
      currentUrl: "https://chatgpt.com/c/abc?token=secret#message",
      currentTitle: ` ${"x".repeat(600)} `,
      recents: [
        { url: "https://chatgpt.com/oauth/callback?code=secret", title: "callback" },
        { url: "https://example.com/", title: "external" },
        { url: "https://chatgpt.com/c/abc?token=secret", title: "safe" },
      ],
    });

    expect(normalized.currentUrl).toBe("https://chatgpt.com/c/abc");
    expect(normalized.currentTitle).toHaveLength(512);
    expect(normalized.recents).toEqual([{ url: "https://chatgpt.com/c/abc", title: "safe" }]);
  });
});
