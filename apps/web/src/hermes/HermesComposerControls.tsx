/**
 * The composer's Hermes provider and model dropdowns, shown beside the agent
 * chip when a Hermes instance is selected. Hermes model slugs are
 * `provider::model`; "Hermes default" leaves the choice to Hermes.
 * Fork add-on: Hermes provider.
 */
import { HERMES_DEFAULT_MODEL } from "@t3tools/contracts";
import { memo, useMemo } from "react";

import {
  ComposerControlSeparator,
  ComposerSelectControl,
  type ComposerControlSize,
} from "../components/chat/ComposerControl";
import { useComposerMenuProps } from "../components/chat/composerEventScope";
import { useComposerMenuState } from "../components/chat/useComposerMenuState";
import { Select, SelectItem, SelectPopup } from "../components/ui/select";
import type { AppModelOption } from "../modelSelection";
import { hermesModelProvider } from "./hermesSessions";

const DEFAULT_PROVIDER = "hermes-default";

interface HermesProviderGroup {
  readonly slug: string;
  readonly name: string;
  readonly models: ReadonlyArray<AppModelOption>;
}

/** The instance's models grouped by Hermes provider, sorted by name. */
function groupHermesModels(
  options: ReadonlyArray<AppModelOption>,
): ReadonlyArray<HermesProviderGroup> {
  const groups = new Map<string, { name: string; models: AppModelOption[] }>();
  for (const option of options) {
    const slug = hermesModelProvider(option.slug);
    if (slug === null) continue;
    const group = groups.get(slug);
    if (group) group.models.push(option);
    else groups.set(slug, { name: option.subProvider ?? slug, models: [option] });
  }
  return [...groups]
    .map(([slug, group]) => ({ slug, name: group.name, models: group.models }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export const HermesModelControls = memo(function HermesModelControls(props: {
  readonly options: ReadonlyArray<AppModelOption>;
  readonly model: string;
  readonly size: ComposerControlSize;
  readonly hidden: boolean;
  readonly disabled: boolean;
  readonly onModelChange: (model: string) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [providerOpen, setProviderOpen] = useComposerMenuState(props.hidden);
  const [modelOpen, setModelOpen] = useComposerMenuState(props.hidden);
  const groups = useMemo(() => groupHermesModels(props.options), [props.options]);
  const providerSlug = hermesModelProvider(props.model);
  const group = groups.find((candidate) => candidate.slug === providerSlug);
  const model = group?.models.find((candidate) => candidate.slug === props.model);
  const offersDefault =
    group === undefined || props.options.some((option) => option.slug === HERMES_DEFAULT_MODEL);

  const selectProvider = (value: string | null) => {
    if (value === null || value === providerSlug) return;
    if (value === DEFAULT_PROVIDER) {
      props.onModelChange(HERMES_DEFAULT_MODEL);
      return;
    }
    const first = groups.find((candidate) => candidate.slug === value)?.models[0];
    if (first) props.onModelChange(first.slug);
  };

  return (
    <>
      <ComposerControlSeparator size={props.size} />
      <Select
        open={providerOpen}
        onOpenChange={setProviderOpen}
        value={group?.slug ?? DEFAULT_PROVIDER}
        onValueChange={selectProvider}
        disabled={props.disabled}
      >
        <ComposerSelectControl size={props.size} aria-label="Hermes provider">
          <span className="max-w-40 truncate">
            {group?.name ?? providerSlug ?? "Hermes default"}
          </span>
        </ComposerSelectControl>
        <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
          {offersDefault ? (
            <SelectItem value={DEFAULT_PROVIDER} hideIndicator>
              Hermes default
            </SelectItem>
          ) : null}
          {groups.map((candidate) => (
            <SelectItem key={candidate.slug} value={candidate.slug} hideIndicator>
              {candidate.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {group ? (
        <>
          <ComposerControlSeparator size={props.size} />
          <Select
            open={modelOpen}
            onOpenChange={setModelOpen}
            value={props.model}
            onValueChange={(value) => {
              if (value !== null && value !== props.model) props.onModelChange(value);
            }}
            disabled={props.disabled}
          >
            <ComposerSelectControl size={props.size} aria-label="Hermes model">
              <span className="max-w-56 truncate">
                {model?.shortName ?? model?.name ?? props.model}
              </span>
            </ComposerSelectControl>
            <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
              {group.models.map((candidate) => (
                <SelectItem key={candidate.slug} value={candidate.slug} hideIndicator>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </>
      ) : null}
    </>
  );
});
