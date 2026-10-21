/**
 * Existing checkout: whether a machine already has a repository checked out where it keeps its
 * projects, so Add to another machine can add that folder instead of cloning a second copy.
 * Fork add-on: existing checkout.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { AuthFilesystemReadScope, EnvironmentAuthorizationError } from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const EXISTING_CHECKOUT_WS_METHODS = {
  find: "existingCheckout.find",
} as const;

export const ExistingCheckoutFindInput = Schema.Struct({
  /** The source project's `repositoryGroupingKeyOf` key. */
  repositoryKey: TrimmedNonEmptyString,
});
export type ExistingCheckoutFindInput = typeof ExistingCheckoutFindInput.Type;

export const ExistingCheckoutFindResult = Schema.Struct({
  /** The checkout's top folder on this machine; null when none was found. */
  repositoryRoot: Schema.NullOr(Schema.String),
});
export type ExistingCheckoutFindResult = typeof ExistingCheckoutFindResult.Type;

export const ExistingCheckoutFindRpc = Rpc.make(EXISTING_CHECKOUT_WS_METHODS.find, {
  payload: ExistingCheckoutFindInput,
  success: ExistingCheckoutFindResult,
  error: EnvironmentAuthorizationError,
});

export const ExistingCheckoutRpcs = [ExistingCheckoutFindRpc] as const;

/** Spread into the server's `RPC_REQUIRED_SCOPES`. It reports folder paths, like browsing does. */
export const EXISTING_CHECKOUT_RPC_SCOPES = {
  [EXISTING_CHECKOUT_WS_METHODS.find]: AuthFilesystemReadScope,
} as const;
