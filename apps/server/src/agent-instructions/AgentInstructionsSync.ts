/**
 * Builds the instructions from the Agents settings (contracts
 * `buildAgentInstructionsText`) and keeps the provider-core copy in step: one
 * text for the environment and one for each project that overrides a setting.
 * Every provider session started after a save carries the new text.
 * Fork add-on: agent instructions; see docs/user/agent-instructions.md.
 */
import {
  buildAgentInstructionsText,
  type ServerSettings as ServerSettingsValues,
} from "@t3tools/contracts";
import { setForkAgentInstructions } from "@t3tools/provider-core/server/forkAgentInstructions";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";

function applySettings(settings: ServerSettingsValues): void {
  const environment = buildAgentInstructionsText(settings);
  const projects = new Map<string, string>();
  for (const projectId of Object.keys(settings.projectSettingsOverrides) as Array<
    keyof ServerSettingsValues["projectSettingsOverrides"]
  >) {
    const text = buildAgentInstructionsText(resolveProjectSettings(settings, projectId).settings);
    if (text !== environment) projects.set(projectId, text);
  }
  setForkAgentInstructions({ environment, projects });
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const changes = yield* settings.subscribeChanges;
    applySettings(yield* settings.getSettings.pipe(Effect.orDie));
    yield* changes.pipe(
      Stream.runForEach((value) => Effect.sync(() => applySettings(value))),
      Effect.forkScoped,
    );
  }),
);
