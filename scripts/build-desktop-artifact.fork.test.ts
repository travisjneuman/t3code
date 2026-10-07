import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { createBuildConfig, resolveDesktopProductName } from "./build-desktop-artifact.ts";
import { REMOTE_APP_DISTRIBUTION } from "./lib/fork-desktop-artifact.ts";

const protocolSchemes = (config: Record<string, unknown>, platform: "mac" | "linux") =>
  (
    (config[platform] as Record<string, unknown>).protocols as ReadonlyArray<{
      readonly schemes: ReadonlyArray<string>;
    }>
  )[0]?.schemes;

it.layer(NodeServices.layer)("build-desktop-artifact fork add-ons", (it) => {
  it("names every channel after the fork, without a stage label", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), REMOTE_APP_DISTRIBUTION.baseName);
    assert.equal(
      resolveDesktopProductName("0.0.17-nightly.20260413.42"),
      REMOTE_APP_DISTRIBUTION.baseName,
    );
  });

  it.effect("packages the fork identity and records the source checkout on macOS", () =>
    Effect.gen(function* () {
      const unsigned = yield* createBuildConfig(
        "mac",
        "dir",
        "0.0.46-nightly.20261003.9",
        false,
        false,
        undefined,
        undefined,
      );
      const signed = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.46",
        true,
        false,
        undefined,
        undefined,
      );
      const linux = yield* createBuildConfig(
        "linux",
        "AppImage",
        "0.0.46",
        false,
        false,
        undefined,
        undefined,
      );

      assert.equal(unsigned.appId, REMOTE_APP_DISTRIBUTION.appId);
      assert.equal(unsigned.productName, REMOTE_APP_DISTRIBUTION.baseName);
      assert.match(String(unsigned.afterPack), /scripts\/sign-macos-ad-hoc\.cjs$/u);
      assert.notProperty(signed, "afterPack");
      const extraMetadata = unsigned.extraMetadata as Record<string, unknown>;
      assert.isString(extraMetadata.t3codeSourceRepositoryPath);
      assert.deepStrictEqual(protocolSchemes(unsigned, "mac"), [
        REMOTE_APP_DISTRIBUTION.protocol,
        `${REMOTE_APP_DISTRIBUTION.protocol}-dev`,
      ]);
      assert.deepStrictEqual(protocolSchemes(linux, "linux"), [
        REMOTE_APP_DISTRIBUTION.protocol,
        `${REMOTE_APP_DISTRIBUTION.protocol}-dev`,
      ]);
      assert.notProperty(linux, "extraMetadata");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );
});
