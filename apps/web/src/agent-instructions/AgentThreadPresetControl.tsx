/**
 * The composer's Agents preset picker: runs this thread (and the workers it
 * starts) under a preset instead of the project's Agents settings. A thread
 * without a choice shows its parent's or root's, else the default preset.
 * Icon-only while the thread uses the project's settings.
 * Fork add-on: agent instructions.
 */
import {
  AGENT_PROJECT_PRESET_ID,
  type AgentPreset,
  agentPresetForThread,
  agentPresetList,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { UsersIcon } from "lucide-react";
import { memo } from "react";

import {
  ComposerControlIcon,
  ComposerSelectControl,
  type ComposerControlSize,
} from "../components/chat/ComposerControl";
import { useComposerMenuProps } from "../components/chat/composerEventScope";
import { useComposerMenuState } from "../components/chat/useComposerMenuState";
import { MenuRadioGroup, MenuRadioItem, MenuSeparator as MenuDivider } from "../components/ui/menu";
import { Select, SelectItem, SelectPopup } from "../components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../hooks/useSettings";
import { useQuietThreadShell } from "../state/entities";

interface ThreadPresetProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** The presets, the thread's current one, a setter, and item labels that mark the default. */
function useThreadPreset({ environmentId, threadId }: ThreadPresetProps) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const presets = agentPresetList(settings);
  // The server walks every ancestor; the parent and root cover the usual depths.
  const lineage = useQuietThreadShell(scopeThreadRef(environmentId, threadId))?.lineage;
  const preset = agentPresetForThread(settings, [
    threadId,
    lineage?.parentThreadId ?? undefined,
    lineage?.rootThreadId ?? undefined,
  ]);
  // Project settings is stored as a choice of its own so the default preset doesn't apply.
  const setPreset = (value: string | null) =>
    updateSettings({ agentThreadPresets: { [threadId]: value || AGENT_PROJECT_PRESET_ID } });
  const presetLabel = (candidate: AgentPreset) =>
    candidate.id === settings.agentDefaultPresetId ? `${candidate.name} (default)` : candidate.name;
  return { presets, preset, setPreset, presetLabel };
}

export const AgentThreadPresetControl = memo(function AgentThreadPresetControl(
  props: ThreadPresetProps & { size: ComposerControlSize; hidden: boolean },
) {
  const { presets, preset, setPreset, presetLabel } = useThreadPreset(props);
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const tooltip = preset
    ? `Agents preset for this thread: ${presetLabel(preset)}`
    : "Agents preset: this thread uses the project's Agents settings";

  return (
    <>
      <Tooltip>
        <Select
          open={open}
          onOpenChange={setOpen}
          value={preset?.id ?? AGENT_PROJECT_PRESET_ID}
          onValueChange={setPreset}
        >
          <TooltipTrigger
            render={
              <ComposerSelectControl size={props.size} aria-label="Agents preset for this thread" />
            }
          >
            <ComposerControlIcon icon={UsersIcon} size={props.size} />
            <span data-composer-control-label className={preset ? undefined : "sr-only"}>
              {preset?.name ?? "Project settings"}
            </span>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
            <SelectItem value={AGENT_PROJECT_PRESET_ID} hideIndicator>
              Project settings
            </SelectItem>
            {presets.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id} hideIndicator>
                {presetLabel(candidate)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
    </>
  );
});

/** The same choice as radio items, for the composer's overflow menu. */
export function AgentThreadPresetMenuItems(props: ThreadPresetProps) {
  const { presets, preset, setPreset, presetLabel } = useThreadPreset(props);
  return (
    <>
      <MenuDivider />
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Agents preset</div>
      <MenuRadioGroup
        value={preset?.id ?? AGENT_PROJECT_PRESET_ID}
        onValueChange={(value) => setPreset(typeof value === "string" ? value : null)}
      >
        <MenuRadioItem value={AGENT_PROJECT_PRESET_ID}>Project settings</MenuRadioItem>
        {presets.map((candidate) => (
          <MenuRadioItem key={candidate.id} value={candidate.id}>
            {presetLabel(candidate)}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </>
  );
}
