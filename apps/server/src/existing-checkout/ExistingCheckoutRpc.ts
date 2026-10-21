/**
 * WebSocket handler for finding an existing checkout: calls one ExistingCheckout method.
 * Fork add-on: existing checkout.
 *
 * @module existing-checkout/ExistingCheckoutRpc
 */
import { EXISTING_CHECKOUT_WS_METHODS, type ExistingCheckoutFindInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ExistingCheckout from "./ExistingCheckout.ts";

export const makeHandlers = Effect.gen(function* () {
  const existingCheckout = yield* ExistingCheckout.ExistingCheckout;
  return {
    [EXISTING_CHECKOUT_WS_METHODS.find]: (input: ExistingCheckoutFindInput) =>
      existingCheckout.find(input),
  };
}).pipe(Effect.provide(ExistingCheckout.layer));
