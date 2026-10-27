/**
 * Header count and Show more icons for the single-line agent lists (subagents,
 * Other Agents, Hermes), matching upstream's shelf headers: the count sits in its
 * own trailing slot and a chevron reveals more. Fork add-on: compact sidebar cards.
 */
import { ChevronDownIcon, ChevronUpIcon, CircleDashedIcon } from "lucide-react";
import type { ReactNode } from "react";

import { AGENT_LINE_ICON_CLASS } from "./agentLines";

export function AgentSectionAccessory(props: {
  count: number;
  running: number;
  /** Extra text after the running count, such as a container-query " active". */
  runningSuffix?: ReactNode;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {props.running > 0 ? (
        <span
          title={`${props.running} active`}
          className="inline-flex shrink-0 items-center gap-1 text-info-foreground tabular-nums"
        >
          <CircleDashedIcon aria-hidden className="size-3 shrink-0" />
          {props.running}
          {props.runningSuffix}
        </span>
      ) : null}
      <span className="font-normal tabular-nums">{props.count}</span>
    </span>
  );
}

export function AgentMoreIcon({ less = false }: { less?: boolean }) {
  const Chevron = less ? ChevronUpIcon : ChevronDownIcon;
  return <Chevron aria-hidden className={AGENT_LINE_ICON_CLASS} />;
}
