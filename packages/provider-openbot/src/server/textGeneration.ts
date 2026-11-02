import { TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";

/** Every prompt lands in an OpenBot agent's conversation, so T3's own text jobs are refused. */
export const openbotTextGeneration = TextGenerationOperations.fromRunner(
  "OpenBotTextGeneration",
  (request) =>
    Effect.fail(
      new TextGenerationError({
        operation: request.operation,
        detail: "OpenBot does not generate text for T3 Code. Choose another model.",
      }),
    ),
);
