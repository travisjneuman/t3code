/**
 * The fork's background server workers, merged into upstream's runtime core dependencies with
 * one line in server.ts. Fork add-on; see docs/internals/fork-add-ons.md.
 *
 * @module forkServerLayers
 */
import * as Layer from "effect/Layer";

import * as AgentInstructionsSync from "./agent-instructions/AgentInstructionsSync.ts";
import * as ProjectionStoreV2 from "./orchestration-v2/ProjectionStore.ts";
import * as ModelReferenceRepair from "./provider/ModelReferenceRepair.ts";
import * as ThreadRetention from "./thread-retention/ThreadRetention.ts";

export const layer = Layer.mergeAll(
  AgentInstructionsSync.layer, // Fork add-on(agent-instructions)
  ModelReferenceRepair.layer, // Fork add-on(retired-models)
  ThreadRetention.layer.pipe(Layer.provide(ProjectionStoreV2.layer)), // Fork add-on(thread-retention)
);
