import { assert, describe, it } from "@effect/vitest";

import { resolveMacApplicationBundlePath } from "./LocalSourceUpdates.ts";

const dirname = (value: string): string => value.slice(0, value.lastIndexOf("/"));
const resolvePath = (base: string, ...segments: ReadonlyArray<string>): string => {
  const parts = base.split("/").filter((part) => part.length > 0);
  for (const segment of segments) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return `/${parts.join("/")}`;
};

describe("local source desktop updates", () => {
  it("resolves the installed app bundle from the macOS executable path", () => {
    assert.equal(
      resolveMacApplicationBundlePath(
        "/Applications/ndev.t3code.app/Contents/MacOS/ndev.t3code",
        resolvePath,
        dirname,
      ),
      "/Applications/ndev.t3code.app",
    );
  });
});
