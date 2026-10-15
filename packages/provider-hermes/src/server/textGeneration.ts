import { TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";

/**
 * Hermes keeps every prompt it runs as a session, so T3's own text jobs
 * (titles, commit messages) would clutter the agent's history. It refuses them.
 */
export const hermesTextGeneration = TextGenerationOperations.fromRunner(
  "HermesTextGeneration",
  (request) =>
    Effect.fail(
      new TextGenerationError({
        operation: request.operation,
        detail: "Hermes Agent does not generate text for T3 Code. Choose another model.",
      }),
    ),
);
