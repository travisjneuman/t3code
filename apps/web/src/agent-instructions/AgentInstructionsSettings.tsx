/**
 * Settings section for the instructions T3 Code gives every agent it runs,
 * ahead of conflicting CLAUDE.md or AGENTS.md rules. Rendered in Settings,
 * General, above Text generation.
 * Fork add-on: agent instructions.
 */
import { useRef } from "react";

import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { searchableSetting } from "../components/settings/settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Textarea } from "../components/ui/textarea";

export function AgentInstructionsSettingsSection() {
  const value = useScopedSettings((settings) => settings.agentInstructions);
  const mixed = useScopedSettingsMixed(["agentInstructions"]);
  const updateSettings = useUpdateScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const edited = useRef(false);
  return (
    <SettingsSection id="agents" title="Agents">
      <SettingsRow
        serverScoped
        settingKeys={["agentInstructions"]}
        {...searchableSetting("agent-instructions")}
        description="Given to every agent T3 Code runs, in every project, and followed over conflicting CLAUDE.md or AGENTS.md rules. Running Claude and Pi sessions keep the text they started with."
        resetAction={
          mixed || value !== "" ? (
            <SettingResetButton
              label="agent instructions"
              onClick={() => updateSettings({ agentInstructions: "" })}
            />
          ) : null
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={`${scopeKey}:${mixed}:${value}`}
            aria-label="Agent instructions"
            onChange={() => {
              edited.current = true;
            }}
            rows={8}
            defaultValue={mixed ? "" : value}
            placeholder={
              mixed
                ? "Mixed. Enter instructions to apply to all selected environments."
                : "Delegate with the t3-code delegate_task tool instead of native subagents."
            }
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (edited.current && (mixed || next !== value)) {
                updateSettings({ agentInstructions: next });
              }
              edited.current = false;
            }}
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
