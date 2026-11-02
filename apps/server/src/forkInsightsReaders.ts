import { ProviderDriverKind } from "@t3tools/contracts";

import { readHermesInsights } from "./hermes/hermesInsightsReader.ts";
import type { DriverInsightsReader } from "./sessionInsights/SessionInsights.ts";

/** Session-details readers for drivers that keep their own session store, keyed by driver. */
export const FORK_INSIGHTS_READERS: ReadonlyMap<ProviderDriverKind, DriverInsightsReader> = new Map([
  [ProviderDriverKind.make("hermes"), readHermesInsights], // Fork add-on(hermes)
]);
