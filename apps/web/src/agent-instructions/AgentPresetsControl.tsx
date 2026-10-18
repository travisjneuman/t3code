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
  BUILTIN_AGENT_PRESETS,
  isBuiltinAgentPreset,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
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
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useUpdateEnvironmentSettings } from "../hooks/useSettings";
import { ChoiceSelect } from "./ChoiceSelect";

function newPresetId(): string {
  // crypto.randomUUID needs a secure context, which a LAN origin may not be.
  return `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Whether every value the preset sets equals the scope's current one. */
function presetMatches(preset: AgentPreset, settings: object): boolean {
  const current = settings as Readonly<Record<string, unknown>>;
  return Object.entries(preset.settings).every(
    ([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value),
  );
}

export function AgentPresetsControl() {
  const settings = useScopedSettings();
  const updateScoped = useUpdateScopedSettings();
  const { target } = useSettingsScope();
  const updateEnvironment = useUpdateEnvironmentSettings(target?.environmentId ?? null);
  const presets = agentPresetList(settings);
  // The last preset applied, saved or picked stays selected across visits, so
  // Save current offers to replace it after a value changes.
  const [selectedId, setSelectedId] = useLocalStorage(
    `t3code:agent-preset-selection:${target?.environmentId ?? "none"}`,
    "",
    Schema.String,
  );
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const selected =
    presets.find((preset) => preset.id === selectedId) ??
    // Saved presets set every value, so one that matches is the scope's own.
    settings.agentPresets.find((preset) => presetMatches(preset, settings)) ??
    BUILTIN_AGENT_PRESETS.find((preset) => presetMatches(preset, settings)) ??
    presets[0];
  const trimmedName = name.trim();
  const nameIsBuiltin = BUILTIN_AGENT_PRESETS.some(
    (preset) => preset.name.toLowerCase() === trimmedName.toLowerCase(),
  );
  const replacing = settings.agentPresets.some((preset) => preset.name === trimmedName);

  const savePreset = () => {
    const trimmed = trimmedName;
    if (trimmed === "" || nameIsBuiltin) return;
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
          if (!selected) return;
          updateScoped(selected.settings);
          setSelectedId(selected.id);
        }}
      >
        Apply
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={target === null}
        onClick={() => {
          // Built-ins can't change, so only a saved preset is offered for replacing.
          setName(selected && !isBuiltinAgentPreset(selected.id) ? selected.name : "");
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
            setSelectedId("");
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
              Saves every Agents value for the scope picked above. A saved preset with the same name
              is replaced; built-in presets can't be.
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
            {nameIsBuiltin ? (
              <p className="mt-2 text-destructive-foreground text-xs">
                {trimmedName} is a built-in preset. Pick another name.
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaving(false)}>
              Cancel
            </Button>
            <Button disabled={trimmedName === "" || nameIsBuiltin} onClick={savePreset}>
              {replacing ? "Replace" : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
