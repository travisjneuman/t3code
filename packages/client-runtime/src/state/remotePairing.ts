/**
 * Mints a pairing credential on a connected environment, so another device can pair with that
 * environment directly instead of only through this client. Fork add-on: pair remote devices.
 */
import type { AuthPairingCredentialResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const PAIRING_TIMEOUT_MS = 10_000;

export const mintRemotePairingCredential = Effect.fn(
  "clientRuntime.state.mintRemotePairingCredential",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly label: string;
}): Effect.fn.Return<
  AuthPairingCredentialResult,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    group: "auth",
    method: "POST",
    url: (urls) => urls.pairingCredential(),
    timeoutMs: PAIRING_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.pairingCredential({ headers, payload: { label: input.label } }),
  });
});
