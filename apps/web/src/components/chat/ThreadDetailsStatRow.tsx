import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/** A label and value on one line, for the session and context readouts. */
export function ThreadDetailsStatRow(props: {
  readonly label: ReactNode;
  readonly children: ReactNode;
  readonly dimmed?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center justify-between gap-3 px-2.5 text-2xs leading-5",
        props.dimmed && "opacity-55",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
        {props.label}
      </span>
      <span className="max-w-[65%] min-w-0 truncate text-right font-medium text-foreground/80 tabular-nums">
        {props.children}
      </span>
    </div>
  );
}

/** A small status dot; `className` carries the theme color token. */
export function ThreadDetailsStatusDot(props: { readonly className: string }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", props.className)} />;
}
