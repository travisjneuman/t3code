/**
 * The Repair agents setting: who a source update hands a merge conflict or a broken build to,
 * in order. The desktop app reads it from its own machine. Fork add-on: upstream sync.
 */
import { DEFAULT_REPAIR_AGENTS, parseRepairAgents, repairAgentLabel } from "@t3tools/contracts";

import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Textarea } from "../components/ui/textarea";

export function RepairAgentsSettings() {
  const { scope } = useSettingsScope();
  const value = useScopedSettings((settings) => settings.sourceUpdateRepairAgents);
  const updateSettings = useUpdateScopedSettings();
  // The order belongs to the machine whose app builds from source, not to a project.
  if (scope.kind !== "all" && scope.kind !== "environment") return null;
  const agents = parseRepairAgents(value);
  return (
    <SettingsSection title="Source update repairs">
      <SettingsRow
        serverScoped
        settingKeys={["sourceUpdateRepairAgents"]}
        title="Repair agents"
        description="Who fixes a merge conflict or a broken build during a source update, tried in order. One per line: pi or claude, a model, an effort. This Mac's app reads its own machine's list."
        resetAction={
          value !== DEFAULT_REPAIR_AGENTS ? (
            <SettingResetButton
              label="repair agents"
              onClick={() => updateSettings({ sourceUpdateRepairAgents: DEFAULT_REPAIR_AGENTS })}
            />
          ) : null
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={value}
            aria-label="Repair agents"
            rows={4}
            spellCheck={false}
            defaultValue={value}
            placeholder={DEFAULT_REPAIR_AGENTS}
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next !== value) updateSettings({ sourceUpdateRepairAgents: next });
            }}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {agents.length === 0
              ? "No line names an agent, a model and an effort, so the default order is used."
              : `In order: ${agents.map(repairAgentLabel).join(", then ")}.`}
          </p>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
