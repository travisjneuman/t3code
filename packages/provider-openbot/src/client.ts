/**
 * OpenBot's client definition: settings form, label, and glyph.
 * Browser- and React Native-safe.
 *
 * @module provider-openbot/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OpenBotSettings } from "./settings.ts";

export const openbotClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("openbot"),
  label: "OpenBot",
  settingsSchema: OpenBotSettings,
  badgeLabel: "Beta",
  // A robot head: antenna, ears, two eyes and a mouth.
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0d9488", dark: "#2dd4bf" },
    paths: [
      {
        fillRule: "evenodd",
        d: "M11 1.5h2V5h4a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h4zM9 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3m6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3M8.5 15v1.5h7V15zM1 10h2v5H1zm20 0h2v5h-2z",
      },
    ],
  },
});
