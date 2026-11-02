/**
 * The fork's background server workers, merged into upstream's runtime core dependencies with
 * one line in server.ts. Fork add-on; see docs/internals/fork-add-ons.md.
 *
 * @module forkServerLayers
 */
import * as Layer from "effect/Layer";

// fork-addons:begin
import * as AgentInstructionsSync from "./agent-instructions/AgentInstructionsSync.ts"; // Fork add-on(agent-instructions)
import * as ProjectionStoreV2 from "./orchestration-v2/ProjectionStore.ts"; // Fork add-on(thread-retention)
import * as ModelReferenceRepair from "./provider/ModelReferenceRepair.ts"; // Fork add-on(retired-models)
import * as ThreadRetention from "./thread-retention/ThreadRetention.ts"; // Fork add-on(thread-retention)

export const layer = Layer.mergeAll(
  Layer.empty,
  AgentInstructionsSync.layer, // Fork add-on(agent-instructions)
  ModelReferenceRepair.layer, // Fork add-on(retired-models)
  ThreadRetention.layer.pipe(Layer.provide(ProjectionStoreV2.layer)), // Fork add-on(thread-retention)
);
// fork-addons:end
