import { describe, expect, it } from "vite-plus/test";

import {
  classifyRemoteAppNavigation,
  isTrustedRemoteHost,
  isTrustedRemoteUrl,
  sanitizePersistedUrl,
} from "./RemoteAppPolicy.ts";

describe("RemoteAppPolicy", () => {
  it("accepts first-party HTTPS origins without accepting lookalikes", () => {
    expect(isTrustedRemoteHost("chatgpt.com")).toBe(true);
    expect(isTrustedRemoteHost("sub.chatgpt.com")).toBe(true);
    expect(isTrustedRemoteHost("chatgpt.com.evil.example")).toBe(false);
    expect(isTrustedRemoteUrl("https://chatgpt.com/")).toBe(true);
    expect(isTrustedRemoteUrl("http://chatgpt.com/")).toBe(false);
  });

  it("keeps unsafe schemes and auth providers out of the embedded view", () => {
    expect(classifyRemoteAppNavigation("file:///etc/passwd").kind).toBe("deny");
    expect(classifyRemoteAppNavigation("javascript:alert(1)").kind).toBe("deny");
    expect(classifyRemoteAppNavigation("https://accounts.google.com/signin").kind).toBe("deny");
    expect(
      classifyRemoteAppNavigation("https://accounts.google.com/signin", { authFlowActive: true })
        .kind,
    ).toBe("auth");
    expect(classifyRemoteAppNavigation("https://example.com/").kind).toBe("external");
  });

  it("persists only sanitized first-party locations", () => {
    expect(sanitizePersistedUrl("https://chatgpt.com/c/abc?token=secret#message")).toBe(
      "https://chatgpt.com/c/abc",
    );
    expect(sanitizePersistedUrl("https://chatgpt.com/oauth/callback?code=secret")).toBeNull();
    expect(sanitizePersistedUrl("https://chatgpt.com@evil.example/")).toBeNull();
  });
});
