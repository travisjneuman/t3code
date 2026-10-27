/**
 * The Agents "Presets" row: apply a named set of Agents values to the scope
 * picked above, save the current values as a preset, make one the default for
 * threads without a choice, or rename or delete a saved one. A preset holds only
 * the values that differ from the defaults, and applying it leaves the rest.
 * Saved presets and the default live in the environment's settings, next to the
 * built-ins.
 * Fork add-on: agent instructions.
 */
import {
  type AgentPreset,
  agentPresetList,
  agentSettingsDifferences,
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
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { ChoiceSelect } from "./ChoiceSelect";

function newPresetId(): string {
  // crypto.randomUUID needs a secure context, which a LAN origin may not be.
  return `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** One environment's list with `preset` in place of the entry with its id, or added. */
function upsertPreset(current: readonly AgentPreset[], preset: AgentPreset): AgentPreset[] {
  return current.some((entry) => entry.id === preset.id)
    ? current.map((entry) => (entry.id === preset.id ? preset : entry))
    : [...current, preset];
}

/** Whether every value the preset sets equals the scope's current one. */
function presetMatches(preset: AgentPreset, settings: object): boolean {
  const current = settings as Readonly<Record<string, unknown>>;
  return Object.entries(preset.settings).every(
    ([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value),
  );
}

type NameDialog = "save" | "rename" | null;

export function AgentPresetsControl() {
  const settings = useScopedSettings();
  const updateScoped = useUpdateScopedSettings();
  const { target, connectedEnvironments } = useSettingsScope();
  const persist = useAtomCommand(serverEnvironment.updateSettings, "Agents preset update");
  const presets = agentPresetList(settings);
  // The last preset applied, saved or picked stays selected across visits, so
  // Save current offers to replace it after a value changes.
  const [selectedId, setSelectedId] = useLocalStorage(
    `t3code:agent-preset-selection:${target?.environmentId ?? "none"}`,
    "",
    Schema.String,
  );
  const [dialog, setDialog] = useState<NameDialog>(null);
  const [name, setName] = useState("");
  const selected =
    presets.find((preset) => preset.id === selectedId) ??
    settings.agentPresets.find((preset) => presetMatches(preset, settings)) ??
    BUILTIN_AGENT_PRESETS.find((preset) => presetMatches(preset, settings));
  const edited = selected !== undefined && !presetMatches(selected, settings);
  const trimmedName = name.trim();
  const nameIsBuiltin = BUILTIN_AGENT_PRESETS.some(
    (preset) => preset.name.toLowerCase() === trimmedName.toLowerCase(),
  );
  const replacing = settings.agentPresets.some((preset) => preset.name === trimmedName);
  const renameTaken = settings.agentPresets.some(
    (preset) => preset.name === trimmedName && preset.id !== selected?.id,
  );
  const nameInvalid = trimmedName === "" || nameIsBuiltin || (dialog === "rename" && renameTaken);
  const isDefault = selected !== undefined && selected.id === settings.agentDefaultPresetId;
  const savedSelected =
    selected !== undefined && !isBuiltinAgentPreset(selected.id) ? selected : undefined;

  // A thread can only use a preset its own environment has, so a saved or
  // renamed preset is copied by id to each environment the scope covers. Each
  // environment keeps its own default and its other presets.
  const copyPreset = (preset: AgentPreset) => {
    for (const environment of connectedEnvironments) {
      if (!environment.serverConfig) continue;
      void persist({
        environmentId: environment.environmentId,
        input: {
          patch: {
            agentPresets: upsertPreset(environment.serverConfig.settings.agentPresets, preset),
          },
        },
      });
    }
  };

  // Threads that chose the deleted preset go back to their default.
  const deletePreset = (id: string) => {
    for (const environment of connectedEnvironments) {
      if (!environment.serverConfig) continue;
      const current = environment.serverConfig.settings;
      if (!current.agentPresets.some((preset) => preset.id === id)) continue;
      void persist({
        environmentId: environment.environmentId,
        input: {
          patch: {
            agentPresets: current.agentPresets.filter((preset) => preset.id !== id),
            agentThreadPresets: Object.fromEntries(
              Object.entries(current.agentThreadPresets)
                .filter(([, presetId]) => presetId === id)
                .map(([threadId]) => [threadId, ""]),
            ),
            ...(current.agentDefaultPresetId === id ? { agentDefaultPresetId: "" } : {}),
          },
        },
      });
    }
  };

  const setDefault = (presetId: string) => {
    if (!target) return;
    void persist({
      environmentId: target.environmentId,
      input: { patch: { agentDefaultPresetId: presetId } },
    });
  };

  const savePreset = () => {
    const trimmed = trimmedName;
    if (trimmed === "" || nameIsBuiltin) return;
    const existing = settings.agentPresets.find((preset) => preset.name === trimmed);
    const preset: AgentPreset = {
      id: existing?.id ?? newPresetId(),
      name: trimmed,
      settings: agentSettingsDifferences(settings),
    };
    copyPreset(preset);
    setSelectedId(preset.id);
    setDialog(null);
  };

  // The id stays, so threads on this preset and the default keep pointing at it.
  const renamePreset = () => {
    if (!savedSelected || nameInvalid) return;
    copyPreset({ ...savedSelected, name: trimmedName });
    setDialog(null);
  };

  const submitName = dialog === "rename" ? renamePreset : savePreset;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ChoiceSelect
        value={selected?.id ?? null}
        options={presets.map(
          (preset) =>
            [
              preset.id,
              `${preset.name}${preset.id === settings.agentDefaultPresetId ? " (default)" : ""}${
                edited && preset.id === selected?.id ? " (edited)" : ""
              }`,
            ] as const,
        )}
        ariaLabel="Preset"
        emptyLabel="Custom"
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
          setName(savedSelected?.name ?? "");
          setDialog("save");
        }}
      >
        Save current
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={selected === undefined || target === null}
        onClick={() => {
          if (!selected) return;
          setDefault(isDefault ? "" : selected.id);
        }}
      >
        {isDefault ? "Clear default" : "Set default"}
      </Button>
      {savedSelected ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setName(savedSelected.name);
            setDialog("rename");
          }}
        >
          Rename
        </Button>
      ) : null}
      {savedSelected ? (
        <Button
          size="xs"
          variant="ghost-destructive"
          onClick={() => {
            deletePreset(savedSelected.id);
            setSelectedId("");
          }}
        >
          Delete
        </Button>
      ) : null}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialog === "rename" ? "Rename Agents preset" : "Save Agents preset"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "rename"
                ? "Threads using this preset, and the default, keep using it under the new name."
                : "Saves the Agents values for the scope picked above that differ from the defaults; applying the preset leaves the others as they are. A saved preset with the same name is replaced; built-in presets can't be."}
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
                if (event.key === "Enter") submitName();
              }}
            />
            {nameIsBuiltin ? (
              <p className="mt-2 text-destructive-foreground text-xs">
                {trimmedName} is a built-in preset. Pick another name.
              </p>
            ) : dialog === "rename" && renameTaken ? (
              <p className="mt-2 text-destructive-foreground text-xs">
                Another saved preset is named {trimmedName}. Pick another name.
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button disabled={nameInvalid} onClick={submitName}>
              {dialog === "rename" ? "Rename" : replacing ? "Replace" : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
