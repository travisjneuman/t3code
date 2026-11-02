/**
 * The fork's server settings, spread into upstream's `ServerSettings` and
 * `ServerSettingsPatch` with one line each. Fork add-on; see
 * docs/internals/fork-add-ons.md.
 */
import { AgentServerSettingsFields, AgentSettingsPatchFields } from "./forkAgentSettings.ts";
import { SaveToNotesSettingsFields, SaveToNotesSettingsPatchFields } from "./saveToNotes.ts";
import {
  ThreadRetentionSettingsFields,
  ThreadRetentionSettingsPatchFields,
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
