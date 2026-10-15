/**
 * Hermes Agent instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-hermes/settings
 */
import {
  CustomModelSetting,
  makeProviderSettingsSchema,
  secretSetting,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const HermesSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    apiUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API URL",
        description: "The Hermes API server, for example over your tailnet.",
        providerSettingsForm: { placeholder: "http://hermes-host:8642", clearWhenEmpty: "omit" },
      }),
    ),
    apiKey: TrimmedString.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API key",
        description: "The Hermes API_SERVER_KEY. Stored separately on the host.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Bearer key",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    agentName: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Agent name",
        description: "Shown on the sidebar section. Blank shows Hermes.",
        providerSettingsForm: { placeholder: "Hermes", clearWhenEmpty: "omit" },
      }),
    ),
    dashboardUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Dashboard URL",
        description: "The Hermes dashboard, for config, keys and custom endpoints.",
        providerSettingsForm: { placeholder: "http://hermes-host:9119", clearWhenEmpty: "omit" },
      }),
    ),
    dashboardUsername: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Dashboard username",
        providerSettingsForm: { placeholder: "Optional", clearWhenEmpty: "omit" },
      }),
    ),
    dashboardPassword: TrimmedString.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Dashboard password",
        description: "Stored separately on the host.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    /** Hermes provider slugs the model picker leaves out. Anthropic is always left out. */
    hiddenProviders: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    /** Hermes's API server gets T3's thread tools; set by the T3 tools switch. */
    t3Tools: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    /** The T3 `/mcp` URL Hermes calls. */
    t3ToolsUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    /** The bridge key Hermes presents; T3 binds each call to this instance's running thread. */
    t3ToolsKey: TrimmedString.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    /** JSON of the Hermes config values the switch changed, restored when it is turned off. */
    t3ToolsRestore: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: [
      "apiUrl",
      "apiKey",
      "agentName",
      "dashboardUrl",
      "dashboardUsername",
      "dashboardPassword",
    ],
  },
);
export type HermesSettings = typeof HermesSettings.Type;
