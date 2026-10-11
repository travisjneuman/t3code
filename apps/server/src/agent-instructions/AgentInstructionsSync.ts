/**
 * Keeps the provider-core copy of the user's agent instructions in step with
 * the `agentInstructions` server setting, so every provider session started
 * after a save carries the new text in its system prompt.
 * Fork add-on: agent instructions; see docs/user/agent-instructions.md.
 */
import { setForkAgentInstructions } from "@t3tools/provider-core/server/forkAgentInstructions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const changes = yield* settings.subscribeChanges;
    const initial = yield* settings.getSettings.pipe(Effect.orDie);
    setForkAgentInstructions(initial.agentInstructions);
    yield* changes.pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => setForkAgentInstructions(value.agentInstructions)),
      ),
      Effect.forkScoped,
    );
  }),
);
