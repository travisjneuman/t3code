/**
 * The fork's server settings, spread into upstream's `ServerSettings` and
 * `ServerSettingsPatch` with one line each. Fork add-on; see
 * docs/internals/fork-add-ons.md.
 */
// fork-addons:begin export only
import { AgentServerSettingsFields, AgentSettingsPatchFields } from "./forkAgentSettings.ts"; // Fork add-on(agent-instructions)
import { SaveToNotesSettingsFields, SaveToNotesSettingsPatchFields } from "./saveToNotes.ts"; // Fork add-on(save-to-notes)
import {
  ThreadRetentionSettingsFields, // Fork add-on(thread-retention)
  ThreadRetentionSettingsPatchFields, // Fork add-on(thread-retention)
} from "./threadRetention.ts";

export const ForkServerSettingsFields = {
  ...SaveToNotesSettingsFields, // Fork add-on(save-to-notes)
  ...AgentServerSettingsFields, // Fork add-on(agent-instructions)
  ...ThreadRetentionSettingsFields, // Fork add-on(thread-retention)
};

export const ForkServerSettingsPatchFields = {
  ...SaveToNotesSettingsPatchFields, // Fork add-on(save-to-notes)
  ...AgentSettingsPatchFields, // Fork add-on(agent-instructions)
  ...ThreadRetentionSettingsPatchFields, // Fork add-on(thread-retention)
};
// fork-addons:end
