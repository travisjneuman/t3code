import { assert, describe, it } from "@effect/vitest";

import {
  findLostForkMarkers,
  normalizeGitHubRemote,
  parseMarkerCounts,
  parseNameStatus,
  resolveMacApplicationBundlePath,
  selectNewestNightlyTag,
  summarizePushFailure,
} from "./LocalSourceUpdates.ts";

const dirname = (value: string): string => value.slice(0, value.lastIndexOf("/"));
const resolvePath = (base: string, ...segments: ReadonlyArray<string>): string => {
  const parts = base.split("/").filter((part) => part.length > 0);
  for (const segment of segments) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return `/${parts.join("/")}`;
};

const noChanges = { renamed: new Map<string, string>(), deleted: new Set<string>() };

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

  it("normalizes GitHub remotes regardless of protocol and case", () => {
    for (const remote of [
      "https://github.com/pingdotgg/t3code.git",
      "https://github.com/PingDotGG/T3Code",
      "https://user@github.com/pingdotgg/t3code.git/",
      "git@github.com:pingdotgg/t3code.git",
      "ssh://git@github.com/pingdotgg/t3code.GIT",
      "ssh://git@github.com:22/pingdotgg/t3code",
      "git://github.com/pingdotgg/t3code.git",
    ]) {
      assert.equal(normalizeGitHubRemote(remote), "pingdotgg/t3code");
    }
    assert.notEqual(
      normalizeGitHubRemote("https://example.com/pingdotgg/t3code.git"),
      "pingdotgg/t3code",
    );
  });

  it("picks the newest nightly tag in version order", () => {
    assert.equal(
      selectNewestNightlyTag(
        "v0.0.45-nightly.20260901.10\nv0.0.46-nightly.20261001.2\nv0.0.46\nv0.0.46-nightly.20261003.9\n",
      ),
      "v0.0.46-nightly.20261003.9",
    );
    assert.equal(selectNewestNightlyTag("v0.0.46\n"), null);
  });

  it("parses fork marker counts from git grep", () => {
    const counts = parseMarkerCounts("HEAD:apps/a.ts\u00003\nHEAD:b.ts\u00001\n", "HEAD:");
    assert.deepStrictEqual(
      [...counts],
      [
        ["apps/a.ts", 3],
        ["b.ts", 1],
      ],
    );
    assert.equal(parseMarkerCounts("").size, 0);
  });

  it("parses renames and deletions from git diff --name-status -z", () => {
    const changes = parseNameStatus(
      "M\u0000a.ts\u0000R087\u0000old.ts\u0000new.ts\u0000D\u0000gone.ts\u0000",
    );
    assert.deepStrictEqual([...changes.renamed], [["old.ts", "new.ts"]]);
    assert.deepStrictEqual([...changes.deleted], ["gone.ts"]);
  });

  it("finds files that lost fork markers, following renames", () => {
    const before = new Map([
      ["kept.ts", 2],
      ["lost.ts", 3],
      ["old.ts", 1],
    ]);
    const after = new Map([
      ["kept.ts", 2],
      ["lost.ts", 1],
      ["new.ts", 1],
    ]);
    const lost = findLostForkMarkers(before, after, {
      renamed: new Map([["old.ts", "new.ts"]]),
      deleted: new Set<string>(),
    });
    assert.deepStrictEqual(lost, [
      { path: "lost.ts", currentPath: "lost.ts", expected: 3, found: 1 },
    ]);
    assert.deepStrictEqual(findLostForkMarkers(before, before, noChanges), []);
  });

  it("reports a deleted file only when its markers did not move elsewhere", () => {
    const before = new Map([["gone.ts", 2]]);
    const changes = { renamed: new Map<string, string>(), deleted: new Set(["gone.ts"]) };
    assert.deepStrictEqual(findLostForkMarkers(before, new Map([["moved.ts", 2]]), changes), []);
    assert.deepStrictEqual(findLostForkMarkers(before, new Map(), changes), [
      { path: "gone.ts", currentPath: null, expected: 2, found: 0 },
    ]);
  });

  it("summarizes why a push was skipped", () => {
    assert.equal(
      summarizePushFailure(
        " ! [rejected]        HEAD -> main (fetch first)\nhint: Updates were rejected\n",
      ),
      "! [rejected]        HEAD -> main (fetch first)",
    );
    assert.equal(
      summarizePushFailure("fatal: could not read Username: terminal prompts disabled\n"),
      "fatal: could not read Username: terminal prompts disabled",
    );
    assert.equal(summarizePushFailure(""), "git push failed");
  });
});
