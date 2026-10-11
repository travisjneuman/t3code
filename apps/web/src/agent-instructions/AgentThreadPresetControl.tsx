/**
 * The composer's Agents preset picker: runs this thread (and the workers it
 * starts) under a preset instead of the project's Agents settings. Icon-only
 * while the thread uses the project's settings.
 * Fork add-on: agent instructions.
 */
import { agentPresetList, type EnvironmentId } from "@t3tools/contracts";
import { UsersIcon } from "lucide-react";
import { memo } from "react";

import {
  ComposerControlIcon,
  ComposerControlSeparator,
  ComposerSelectControl,
  type ComposerControlSize,
} from "../components/chat/ComposerControl";
import { useComposerMenuProps } from "../components/chat/composerEventScope";
import { useComposerMenuState } from "../components/chat/useComposerMenuState";
import { MenuRadioGroup, MenuRadioItem, MenuSeparator as MenuDivider } from "../components/ui/menu";
import { Select, SelectItem, SelectPopup } from "../components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../hooks/useSettings";

const PROJECT = "project";

interface ThreadPresetProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
}

/** The presets, the thread's current one, and a setter; PROJECT means the project's settings. */
function useThreadPreset({ environmentId, threadId }: ThreadPresetProps) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const presets = agentPresetList(settings);
  const presetId = settings.agentThreadPresets[threadId] ?? "";
  const preset = presets.find((candidate) => candidate.id === presetId);
  const setPreset = (value: string | null) =>
    // Records merge on save, so an empty string drops back to the project.
    updateSettings({
      agentThreadPresets: { [threadId]: value === PROJECT || !value ? "" : value },
    });
  return { presets, preset, setPreset };
}

export const AgentThreadPresetControl = memo(function AgentThreadPresetControl(
  props: ThreadPresetProps & { size: ComposerControlSize; hidden: boolean },
) {
  const { presets, preset, setPreset } = useThreadPreset(props);
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const tooltip = preset
    ? `Agents preset for this thread: ${preset.name}`
    : "Agents preset: this thread uses the project's Agents settings";

  return (
    <>
      <ComposerControlSeparator size={props.size} />
      <Tooltip>
        <Select
          open={open}
          onOpenChange={setOpen}
          value={preset?.id ?? PROJECT}
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
            <SelectItem value={PROJECT} hideIndicator>
              Project settings
            </SelectItem>
            {presets.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id} hideIndicator>
                {candidate.name}
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
  const { presets, preset, setPreset } = useThreadPreset(props);
  return (
    <>
      <MenuDivider />
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Agents preset</div>
      <MenuRadioGroup
        value={preset?.id ?? PROJECT}
        onValueChange={(value) => setPreset(typeof value === "string" ? value : null)}
      >
        <MenuRadioItem value={PROJECT}>Project settings</MenuRadioItem>
        {presets.map((candidate) => (
          <MenuRadioItem key={candidate.id} value={candidate.id}>
            {candidate.name}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </>
  );
}
