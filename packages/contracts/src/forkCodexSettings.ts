// Fork add-on: Codex hidden models. The Codex provider's "Show hidden models"
// switch. contracts/settings.ts spreads these fields into CodexSettings.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CodexHiddenModelsSettingFields = {
  /**
   * Lists the models OpenAI keeps out of Codex's own picker, such as older or
   * long-context versions. Off by default, matching the Codex app.
   */
  showHiddenModels: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
    Schema.annotateKey({
      title: "Show hidden models",
      description:
        "Also list models OpenAI hides from the Codex picker, such as older or long-context versions.",
      providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
    }),
  ),
};
