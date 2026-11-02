/**
 * OpenBot instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-openbot/settings
 */
import { CustomModelSetting, makeProviderSettingsSchema, TrimmedString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const OpenBotSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    sshHost: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "SSH host",
        description:
          "The machine OpenBot runs on, as you would type it after ssh. It needs node 22.13 or newer. Blank means this server.",
        providerSettingsForm: { placeholder: "openbot-host", clearWhenEmpty: "omit" },
      }),
    ),
    configDir: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "OpenBot folder",
        description:
          "OpenBot's config folder on the machine it runs on, holding openbot.db and automation/. Blank uses OpenBot's default there.",
        providerSettingsForm: { placeholder: "~/.config/OpenBot", clearWhenEmpty: "omit" },
      }),
    ),
    defaultAgent: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Default agent",
        description:
          "The agent a new chat starts with, by its OpenBot name. Blank uses the first agent, by name, that has Local scripts on.",
        providerSettingsForm: { placeholder: "Buster", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["sshHost", "configDir", "defaultAgent"] },
);
export type OpenBotSettings = typeof OpenBotSettings.Type;
