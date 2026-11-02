import type { ProviderDriverKind } from "@t3tools/contracts";

import { HERMES_DRIVER } from "./hermes/hermesSessions";
import { OPENBOT_DRIVER } from "./openbot/openbotSessions";

/** Drivers whose agents keep their own session store and work in their own folders, not the T3 project's. */
export const FORK_OWN_WORKSPACE_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set([
  HERMES_DRIVER, // Fork add-on(hermes)
  OPENBOT_DRIVER, // Fork add-on(openbot)
]);
