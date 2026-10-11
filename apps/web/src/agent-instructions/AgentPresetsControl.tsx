/**
 * The Agents "Presets" row: apply a named set of Agents values to the scope
 * picked above, save the current values as a preset, or delete a saved one.
 * Saved presets live in the environment's settings, next to the built-ins.
 * Fork add-on: agent instructions.
 */
import {
  AGENT_PROJECT_SCOPED_SETTING_KEYS,
  type AgentPreset,
  agentPresetList,
  isBuiltinAgentPreset,
} from "@t3tools/contracts";
import { useState } from "react";

import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { useUpdateEnvironmentSettings } from "../hooks/useSettings";
import { ChoiceSelect } from "./ChoiceSelect";

function newPresetId(): string {
  // crypto.randomUUID needs a secure context, which a LAN origin may not be.
  return `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function AgentPresetsControl() {
  const settings = useScopedSettings();
  const updateScoped = useUpdateScopedSettings();
  const { target } = useSettingsScope();
  const updateEnvironment = useUpdateEnvironmentSettings(target?.environmentId ?? null);
  const presets = agentPresetList(settings);
  const [selectedId, setSelectedId] = useState<string>(presets[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const selected = presets.find((preset) => preset.id === selectedId) ?? presets[0];

  const savePreset = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    const values = Object.fromEntries(
      AGENT_PROJECT_SCOPED_SETTING_KEYS.map((key) => [key, settings[key]]),
    ) as AgentPreset["settings"];
    const existing = settings.agentPresets.find((preset) => preset.name === trimmed);
    const preset: AgentPreset = {
      id: existing?.id ?? newPresetId(),
      name: trimmed,
      settings: values,
    };
    updateEnvironment({
      agentPresets: existing
        ? settings.agentPresets.map((entry) => (entry.id === existing.id ? preset : entry))
        : [...settings.agentPresets, preset],
    });
    setSelectedId(preset.id);
    setSaving(false);
  };

  return (
    <div className="flex items-center gap-2">
      <ChoiceSelect
        value={selected?.id ?? null}
        options={presets.map((preset) => [preset.id, preset.name] as const)}
        ariaLabel="Preset"
        onChange={setSelectedId}
      />
      <Button
        size="xs"
        variant="outline"
        disabled={selected === undefined}
        onClick={() => {
          if (selected) updateScoped(selected.settings);
        }}
      >
        Apply
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={target === null}
        onClick={() => {
          setName("");
          setSaving(true);
        }}
      >
        Save current
      </Button>
      {selected && !isBuiltinAgentPreset(selected.id) ? (
        <Button
          size="xs"
          variant="ghost-destructive"
          onClick={() => {
            updateEnvironment({
              agentPresets: settings.agentPresets.filter((preset) => preset.id !== selected.id),
            });
            setSelectedId(presets[0]?.id ?? "");
          }}
        >
          Delete
        </Button>
      ) : null}
      <Dialog open={saving} onOpenChange={setSaving}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Save Agents preset</DialogTitle>
            <DialogDescription>
              Saves every Agents value for the scope picked above. A preset with the same name is
              replaced.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label="Preset name"
              placeholder="Careful reviews"
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") savePreset();
              }}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaving(false)}>
              Cancel
            </Button>
            <Button disabled={name.trim() === ""} onClick={savePreset}>
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
