/**
 * Hermes Agent's client definition: settings form, label, and glyph.
 * Browser- and React Native-safe.
 *
 * @module provider-hermes/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { HermesSettings } from "./settings.ts";

export const hermesClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("hermes"),
  label: "Hermes Agent",
  settingsSchema: HermesSettings,
  badgeLabel: "Beta",
  // A winged "H": two posts, a crossbar, and a wing on each post.
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#7c3aed", dark: "#a78bfa" },
    paths: [
      {
        d: "M7 4h2.5v6.75h5V4H17v16h-2.5v-6.75h-5V20H7zM6 6.5 1.5 4.5 3 7.5 1 8.5l5 1.5zM18 6.5l4.5-2-1.5 3 2 1-5 1.5z",
      },
    ],
  },
});
