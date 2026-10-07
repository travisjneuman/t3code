// Fork add-on: a settling desktop backend can briefly answer auth bootstrap with a 500.
import type { AuthSessionState } from "@t3tools/contracts";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { __setPrimaryHttpRunnerForTests, type PrimaryHttpEffectRunner } from "./lib/runtime";

const LOOPBACK_AUTH = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session",
} as const;

const unauthenticatedSession = (auth: AuthSessionState["auth"]): AuthSessionState => ({
  authenticated: false,
  auth,
});

function installTestBrowser(url: string) {
  const testWindow = {
    location: new URL(url),
    history: {
      replaceState: (_data: unknown, _unused: string, nextUrl: string) => {
        testWindow.location = new URL(nextUrl, testWindow.location.href);
      },
    },
  };
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("document", { title: "T3 Code" });
}

describe("resolveInitialServerAuthGateState (fork)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    installTestBrowser("http://localhost/");
  });

  afterEach(async () => {
    const { __resetServerAuthBootstrapForTests } = await import("./environments/primary");
    __resetServerAuthBootstrapForTests();
    __setPrimaryHttpRunnerForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries an internal auth session error while the desktop backend settles", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const request = HttpClientRequest.get("http://localhost/api/auth/session");
    const response = HttpClientResponse.fromWeb(
      request,
      new Response("Internal Server Error", { status: 500 }),
    );
    const runner: PrimaryHttpEffectRunner = async <A>() => {
      attempts += 1;
      if (attempts < 2) {
        throw new HttpClientError.HttpClientError({
          reason: new HttpClientError.StatusCodeError({ request, response }),
        });
      }
      return unauthenticatedSession(LOOPBACK_AUTH) as A;
    };
    __setPrimaryHttpRunnerForTests(runner);

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    const gateStatePromise = resolveInitialServerAuthGateState();
    await vi.advanceTimersByTimeAsync(500);

    await expect(gateStatePromise).resolves.toEqual({
      status: "requires-auth",
      auth: LOOPBACK_AUTH,
    });
    expect(attempts).toBe(2);
  });
});
