import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { SectionCollapseToggle, useSectionCollapse } from "./ThreadDetailsSectionToggle"; // Fork add-on: collapsible sections.

export function ThreadDetailsSection({
  headingId,
  title,
  actions,
  separated = true,
  showHeading = true,
  children,
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  headingId: string;
  title: string;
  actions?: ReactNode;
  separated?: boolean;
  showHeading?: boolean;
}) {
  const collapse = useSectionCollapse(headingId, showHeading); // Fork add-on: collapsible sections.
  const heading = <SectionCollapseToggle title={title} collapse={collapse} />; // Fork add-on: collapsible sections.
  return (
    <section
      {...props}
      aria-labelledby={showHeading ? headingId : undefined}
      aria-label={showHeading ? undefined : title}
      className={cn("px-2 pt-2 pb-2.5", separated && "border-t border-border/65")}
    >
      <div
        className={cn(
          "mb-1 flex min-h-8 min-w-0 items-center justify-between gap-2 px-2.5",
          !showHeading && "hidden",
        )}
      >
        <h3
          id={headingId}
          className="min-w-0 truncate text-2xs font-medium text-muted-foreground select-none"
        >
          {heading /* Fork add-on: collapsible sections. */}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {collapse.collapsed ? null : children /* Fork add-on: collapsible sections. */}
    </section>
  );
}
