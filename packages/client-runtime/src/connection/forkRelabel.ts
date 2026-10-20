import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type * as Persistence from "../platform/persistence.ts";
import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
  SshConnectionProfile,
} from "./catalog.ts";
import {
  BearerConnectionTarget,
  type ConnectionTarget,
  type PersistedConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import type * as ConnectionProfileStore from "./profileStore.ts";
import { connectionRoutes, entryWithRoutes } from "./routes.ts";

/**
 * Pairing saves the host's name as the environment's label, and nothing refreshed it, so a host
 * renamed afterwards kept its old name in this client. The web client calls this with the name a
 * connected server reports. Mobile lets users edit labels, so it does not.
 */
export type RelabelEnvironment = (
  environmentId: EnvironmentId,
  label: string,
) => Effect.Effect<void>;

function targetWithLabel(target: ConnectionTarget, label: string): ConnectionTarget {
  switch (target._tag) {
    case "BearerConnectionTarget":
      return new BearerConnectionTarget({
        environmentId: target.environmentId,
        label,
        connectionId: target.connectionId,
      });
    case "SshConnectionTarget":
      return new SshConnectionTarget({
        environmentId: target.environmentId,
        label,
        connectionId: target.connectionId,
      });
    case "RelayConnectionTarget":
      return new RelayConnectionTarget({ environmentId: target.environmentId, label });
    case "PrimaryConnectionTarget":
      return target;
  }
}

function routeWithLabel(route: ConnectionRoute, label: string): ConnectionRoute {
  const profile = Option.getOrNull(route.profile);
  return {
    target: targetWithLabel(route.target, label),
    profile:
      profile === null
        ? route.profile
        : Option.some(
            profile._tag === "BearerConnectionProfile"
              ? new BearerConnectionProfile({
                  connectionId: profile.connectionId,
                  environmentId: profile.environmentId,
                  label,
                  httpBaseUrl: profile.httpBaseUrl,
                  wsBaseUrl: profile.wsBaseUrl,
                  ...(profile.learned === undefined ? {} : { learned: profile.learned }),
                  ...(profile.authorization === undefined
                    ? {}
                    : { authorization: profile.authorization }),
                  ...(profile.network === undefined ? {} : { network: profile.network }),
                })
              : new SshConnectionProfile({
                  connectionId: profile.connectionId,
                  environmentId: profile.environmentId,
                  label,
                  target: profile.target,
                }),
          ),
  };
}

/**
 * Same in-place update as learned routes: the running supervisor keeps its connection, because
 * only names changed, not addresses or credentials.
 */
export function makeRelabel<Lease extends { readonly entry: ConnectionCatalogEntry }>(deps: {
  readonly entries: SubscriptionRef.SubscriptionRef<
    ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
  >;
  readonly serviceScopes: SubscriptionRef.SubscriptionRef<ReadonlyMap<EnvironmentId, Lease>>;
  readonly platformEnvironmentIds: Ref.Ref<ReadonlySet<EnvironmentId>>;
  readonly profiles: ConnectionProfileStore.ConnectionProfileStore["Service"];
  readonly registrations: Persistence.ConnectionRegistrationStore["Service"];
  readonly withLeaseLock: <A, E, R>(
    environmentId: EnvironmentId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly persistedRoutes: (
    entry: ConnectionCatalogEntry,
  ) => ReadonlyArray<PersistedConnectionTarget>;
}): RelabelEnvironment {
  return Effect.fn("EnvironmentRegistry.relabel")(function* (
    environmentId: EnvironmentId,
    label: string,
  ) {
    const trimmed = label.trim();
    if (trimmed === "") return;
    yield* deps
      .withLeaseLock(
        environmentId,
        Effect.gen(function* () {
          if ((yield* Ref.get(deps.platformEnvironmentIds)).has(environmentId)) return;
          const entry = (yield* SubscriptionRef.get(deps.entries)).get(environmentId);
          if (entry === undefined || entry.target.label === trimmed) return;
          const routes = connectionRoutes(entry).map((route) => routeWithLabel(route, trimmed));
          for (const route of routes) {
            if (Option.isSome(route.profile)) yield* deps.profiles.put(route.profile.value);
          }
          const next = entryWithRoutes(entry, routes);
          yield* deps.registrations.setRoutes(environmentId, deps.persistedRoutes(next));
          const lease = (yield* SubscriptionRef.get(deps.serviceScopes)).get(environmentId);
          if (lease !== undefined) {
            yield* SubscriptionRef.update(deps.serviceScopes, (current) =>
              new Map(current).set(environmentId, { ...lease, entry: next }),
            );
          }
          yield* SubscriptionRef.update(deps.entries, (current) =>
            new Map(current).set(environmentId, next),
          );
        }),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not save the environment's new name.", {
            environmentId,
            error,
          }),
        ),
      );
  });
}
