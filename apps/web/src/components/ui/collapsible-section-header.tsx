import type { ComponentProps, ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "../../lib/utils";

const tones = {
  muted: { label: "text-sidebar-muted-foreground/60", line: "bg-sidebar-border/60" },
  info: { label: "text-blue-600 dark:text-blue-400", line: "bg-blue-500/20 dark:bg-blue-400/15" },
  emphasized: { label: "text-sidebar-foreground/80", line: "bg-sidebar-foreground/25" },
  accent: { label: "text-primary", line: "bg-primary/50" },
} as const;

export function CollapsibleSectionHeader({
  children,
  expanded,
  tone = "muted",
  variant = "default",
  size = "default", // Fork add-on: compact lineage agents
  accessory,
  ...buttonProps
}: Omit<ComponentProps<"button">, "className" | "style" | "aria-expanded"> & {
  expanded: boolean;
  tone?: keyof typeof tones;
  variant?: "default" | "panel";
  size?: "default" | "compact" | "sidebar"; // Fork add-on: compact lineage agents, compact sidebar
  accessory?: ReactNode;
}) {
  return (
    <button
      {...buttonProps}
      type="button"
      aria-expanded={expanded}
      className={cn(
        "flex w-full cursor-pointer items-center rounded-md text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70", // Fork add-on: compact lineage agents
        size === "compact" // Fork add-on: compact lineage agents
          ? "h-5 gap-1.5 text-3xs"
          : size === "sidebar" // Fork add-on: compact sidebar
            ? "h-5 gap-1.5 text-2xs"
            : "h-8 gap-2 text-xs",
        variant === "panel" ? "ps-2 pe-2.5" : "px-2",
        tones[tone].label,
      )}
    >
      <span className="shrink-0">{children}</span>
      <span aria-hidden className={cn("h-px min-w-2 flex-1", tones[tone].line)} />
      {accessory}
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", !expanded && "rotate-180")}
      />
    </button>
  );
}

export function SectionHeaderStatus({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 text-3xs leading-none text-destructive-foreground">{children}</span>
  );
}
