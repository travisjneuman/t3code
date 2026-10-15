/**
 * The model picker's header row for one Hermes provider group. It is a list
 * item like the legacy-models header, so arrows reach it and Enter or a click
 * expands or collapses the group. Fork add-on: Hermes provider.
 */
import { ChevronRightIcon } from "lucide-react";
import { memo } from "react";

import { ComboboxItem } from "../components/ui/combobox";
import { cn } from "../lib/utils";
import type { HermesModelGroup } from "./hermesModelGroups";

export const HermesModelGroupRow = memo(function HermesModelGroupRow(props: {
  readonly index: number;
  readonly group: HermesModelGroup<unknown>;
}) {
  const count = props.group.models.length;
  return (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={props.group.key}
      aria-expanded={props.group.isExpanded}
      className="group w-full cursor-pointer"
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate text-xs font-medium leading-snug">{props.group.name}</div>
        <div className="mt-1 text-xs font-normal leading-snug text-muted-foreground/70">
          {count} {count === 1 ? "model" : "models"}
        </div>
      </div>
      <ChevronRightIcon
        className={cn("size-4 transition-transform", props.group.isExpanded && "rotate-90")}
      />
    </ComboboxItem>
  );
});
