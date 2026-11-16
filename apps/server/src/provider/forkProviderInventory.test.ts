import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { mergeProviderSnapshot } from "./ProviderRegistry.ts";

// Hermes and OpenBot use upstream's authoritative inventory policy.
describe.each(["hermes", "openbot"] as const)("%s inventory merging", (driver) => {
  const previous = {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    checkedAt: "2026-10-30T00:00:00.000Z",
    version: null,
    models: [
      { slug: "current", name: "Current", isCustom: false, capabilities: null },
      { slug: "retired", name: "Retired", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  } as const satisfies ServerProvider;

  it("drops removed models after a ready listing without ACP nativeSessions metadata", () => {
    const next = { ...previous, models: [previous.models[0]] };
    assert.deepStrictEqual(mergeProviderSnapshot(previous, next).models, next.models);
  });

  it("accepts an empty completed inventory", () => {
    assert.deepStrictEqual(mergeProviderSnapshot(previous, { ...previous, models: [] }).models, []);
  });

  it.each(["warning", "error"] as const)("retains inventory during a %s probe", (status) => {
    const next = { ...previous, status, models: [previous.models[0]] };
    assert.deepStrictEqual(mergeProviderSnapshot(previous, next).models, previous.models);
    assert.deepStrictEqual(
      mergeProviderSnapshot(previous, { ...next, models: [] }).models,
      previous.models,
    );
  });

  it("does not resurrect removals when a later probe fails", () => {
    const ready = mergeProviderSnapshot(previous, { ...previous, models: [previous.models[0]] });
    const failed = { ...ready, status: "error", models: [] } as const;
    assert.deepStrictEqual(mergeProviderSnapshot(ready, failed).models, ready.models);
  });
});
