/**
 * The fork's orchestration services, merged into upstream's `layerProduction` with one hook in
 * runtimeLayer.ts. Upstream's provided layers are module-private there, so the hook passes them
 * in. Fork add-on; see docs/internals/fork-add-ons.md.
 *
 * @module forkRuntimeLayers
 */
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Layer from "effect/Layer";

// fork-addons:begin
import * as ExternalSessions from "../external-sessions/ExternalSessions.ts"; // Fork add-on(other-agents)
import * as HermesSessions from "../hermes/HermesSessions.ts"; // Fork add-on(hermes)
import * as OpenBotSessions from "../openbot/OpenBotSessions.ts"; // Fork add-on(openbot)
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

export const make = <ROut, E, RIn>(upstream: Layer.Layer<ROut, E, RIn>) =>
  Layer.mergeAll(
    Layer.empty,
    ExternalSessions.layer, // Fork add-on(other-agents)
    HermesSessions.layer, // Fork add-on(hermes)
    OpenBotSessions.layer, // Fork add-on(openbot)
    // fork-addons:end
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        upstream,
        IdAllocator.layer,
        ProviderSessionRuntime.layer,
        TurnItemPositionStore.layer,
      ),
    ),
  );
