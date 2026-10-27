/**
 * Header count and Show more icons for the single-line agent lists (subagents,
 * Other Agents, Hermes), matching upstream's shelf headers: the New design puts
 * the count in its own trailing slot and reveals more with a chevron, classic
 * keeps "(N)" in the label and a plus. Fork add-on: compact sidebar cards.
 */
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleDashedIcon,
  MinusIcon,
  PlusIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { AGENT_LINE_ICON_CLASS } from "./agentLines";

export function agentSectionLabel(name: string, count: number, redesign: boolean) {
  return redesign ? name : `${name} (${count})`;
}

export function AgentSectionAccessory(props: {
  count: number;
  running: number;
  redesign: boolean;
  /** Extra text after the running count, such as a container-query " active". */
  runningSuffix?: ReactNode;
}) {
  if (!props.redesign && props.running === 0) return null;
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
      {props.redesign ? <span className="font-normal tabular-nums">{props.count}</span> : null}
    </span>
  );
}

export function AgentMoreIcon({ less = false }: { less?: boolean }) {
  const Classic = less ? MinusIcon : PlusIcon;
  const Chevron = less ? ChevronUpIcon : ChevronDownIcon;
  return (
    <>
      <Classic aria-hidden className={cn(AGENT_LINE_ICON_CLASS, "redesign:hidden")} />
      <Chevron aria-hidden className={cn(AGENT_LINE_ICON_CLASS, "hidden redesign:block")} />
    </>
  );
}
