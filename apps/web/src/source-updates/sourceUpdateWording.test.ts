import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
} from "../components/desktopUpdate.logic";
import { getSourceUpdateActionLabel } from "./sourceUpdateWording";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("source update wording", () => {
  it("labels source updates as local sync and install actions", () => {
    expect(getSourceUpdateActionLabel("download")).toBe("Sync & Build");
    expect(getSourceUpdateActionLabel("install")).toBe("Restart & Install");
    expect(
      getDesktopUpdateButtonTooltip({ ...baseState, sourceUpdate: true, status: "available" }),
    ).toContain("build locally");
  });

  it("keeps upstream tooltips for builds that download releases", () => {
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "available" })).toBe(
      "Update available ready to download",
    );
  });

  it("explains that a source update replaces the installed app from the local build", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        sourceUpdate: true,
        availableVersion: "abc123",
        downloadedVersion: "abc123",
      } as Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">),
    ).toContain("installed app will be replaced from the local build");
  });
});
