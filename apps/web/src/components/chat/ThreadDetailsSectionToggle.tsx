import * as Schema from "effect/Schema";
import { ChevronDownIcon } from "lucide-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";

/**
 * Collapsible thread details sections, like the Claude desktop app's side
 * panel: a titled section folds to its heading, and the choice is kept per
 * section across threads and restarts. Fork add-on.
 */

export interface SectionCollapse {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}

/** A section without a visible heading has no toggle, so it never folds. */
export function useSectionCollapse(headingId: string, showHeading: boolean): SectionCollapse {
  const [stored, setStored] = useLocalStorage(
    `t3code:thread-details:collapsed:${headingId}`,
    false,
    Schema.Boolean,
  );
  const collapsed = showHeading && stored;
  return { collapsed, onToggle: () => setStored(!collapsed) };
}

/** The section title as the toggle, with a chevron that points up while folded. */
export function SectionCollapseToggle(props: {
  readonly title: string;
  readonly collapse: SectionCollapse;
}) {
  const { collapsed, onToggle } = props.collapse;
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="flex max-w-full cursor-pointer items-center gap-1 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
    >
      <span className="truncate">{props.title}</span>
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", collapsed && "rotate-180")}
      />
    </button>
  );
}
