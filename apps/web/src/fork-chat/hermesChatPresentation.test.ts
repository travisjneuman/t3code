import { describe, expect, it } from "vite-plus/test";

import { applyHermesWorkspaceVisibility } from "./hermesChatPresentation";

describe("applyHermesWorkspaceVisibility", () => {
  it("preserves upstream visibility for local workspaces", () => {
    const show = {
      environment: true,
      openIn: false,
      scripts: true,
      branch: false,
      pullRequests: true,
      git: false,
    };
    const upstreamVisibility = { ...show };

    applyHermesWorkspaceVisibility(show, true);

    expect(show).toEqual(upstreamVisibility);
  });

  it("hides every local workspace control for Hermes, including standalone pull requests", () => {
    const show = {
      environment: true,
      openIn: true,
      scripts: true,
      branch: true,
      pullRequests: true,
      git: true,
    };

    applyHermesWorkspaceVisibility(show, false);

    expect(show).toEqual({
      environment: false,
      openIn: false,
      scripts: false,
      branch: false,
      pullRequests: false,
      git: false,
    });
  });
});
