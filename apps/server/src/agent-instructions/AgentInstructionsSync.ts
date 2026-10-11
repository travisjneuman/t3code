/**
 * Installs the provider-core resolver for the Agents settings. It reads the
 * latest settings: the thread's project overrides, then the thread's preset
 * (or its parent's or root's), then contracts `buildAgentInstructionsText` for
 * the provider. Every provider session started after a save carries the result.
 * Fork add-on: agent instructions; see docs/user/agent-instructions.md.
 */
import {
  type AgentSettings,
  applyAgentThreadPreset,
  buildAgentInstructionsText,
  type ProjectId,
  type ServerSettings as ServerSettingsValues,
} from "@t3tools/contracts";
import {
  type ForkAgentResolution,
  type ForkAgentResolvedScope,
  setForkAgentResolver,
} from "@t3tools/provider-core/server/forkAgentInstructions";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";

/** The Agents settings a thread runs under: project overrides, then its preset. */
export function resolveThreadAgentSettings(
  settings: ServerSettingsValues,
  projectId: string | undefined,
  threadIds: ReadonlyArray<string | undefined>,
): AgentSettings {
  const projectSettings =
    projectId === undefined
      ? settings
      : resolveProjectSettings(settings, projectId as ProjectId).settings;
  return applyAgentThreadPreset(projectSettings, threadIds);
}

function makeResolver(settings: ServerSettingsValues) {
  // Turns ask on every start, so results are kept until the next settings change.
  const cache = new Map<string, ForkAgentResolution>();
  return (scope: ForkAgentResolvedScope): ForkAgentResolution => {
    const key = JSON.stringify([scope.projectId, scope.provider, scope.threadIds]);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const resolved = resolveThreadAgentSettings(settings, scope.projectId, scope.threadIds);
    const result = {
      text: buildAgentInstructionsText(resolved, scope.provider),
      blockNativeSubagents: resolved.agentBlockNativeSubagents,
    };
    cache.set(key, result);
    return result;
  };
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const changes = yield* settings.subscribeChanges;
    setForkAgentResolver(makeResolver(yield* settings.getSettings.pipe(Effect.orDie)));
    yield* changes.pipe(
      Stream.runForEach((value) => Effect.sync(() => setForkAgentResolver(makeResolver(value)))),
      Effect.forkScoped,
    );
  }),
);
