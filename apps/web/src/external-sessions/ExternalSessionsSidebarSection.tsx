import { useAtomValue } from "@effect/atom-react";
import { Link, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { PlusIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { useSidebar } from "../components/ui/sidebar";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { formatProviderDriverKindLabel } from "../providerModels";
import { formatRelativeTime } from "../timestampFormat";
import {
  cwdBasename,
  externalSessionEntriesAtom,
  externalSessionTitle,
  LIVENESS_LABEL,
  type ExternalSessionEntry,
} from "./atoms";

const EXPANDED_STORAGE_KEY = "t3code:sidebar:external-sessions-expanded";
/** How many inactive sessions each "Show more" reveals. */
const RECENT_PAGE_SIZE = 20;

/** Static liveness dots; inactive sessions carry none. Never animated. */
const LIVENESS_DOT_PROPS = {
  running: { statusDotClassName: "bg-success" },
  idle: { statusDotClassName: "bg-warning/60" },
  recent: {},
} as const;

function rowKey(environmentId: string, sessionKey: string): string {
  return `${environmentId}\u0000${sessionKey}`;
}

/**
 * "Other agents" shelf: sessions running outside T3 on the connected
 * environments. Running and idle sessions always show; inactive ones page in
 * behind "Show more". Renders nothing while no environment reports any.
 */
export function ExternalSessionsSidebarSection() {
  const entries = useAtomValue(externalSessionEntriesAtom);
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_STORAGE_KEY, true, Schema.Boolean);
  const [recentShown, setRecentShown] = useState(0);
  const nowMinute = useNowMinute();
  const { isMobile, setOpenMobile } = useSidebar();
  const activeKey = useParams({
    strict: false,
    select: (params) =>
      params.environmentId && params.sessionKey
        ? rowKey(params.environmentId, params.sessionKey)
        : null,
  });

  const { live, recent } = useMemo(() => {
    const liveEntries: Array<ExternalSessionEntry> = [];
    const recentEntries: Array<ExternalSessionEntry> = [];
    for (const entry of entries) {
      (entry.session.liveness === "recent" ? recentEntries : liveEntries).push(entry);
    }
    return { live: liveEntries, recent: recentEntries };
  }, [entries]);

  const toggleExpanded = useCallback(() => setExpanded((value) => !value), [setExpanded]);
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (entries.length === 0) return null;

  const visibleRecent = recentShown > 0 ? recent.slice(0, recentShown) : [];
  const hiddenRecentCount = recent.length - visibleRecent.length;
  const visible = visibleRecent.length > 0 ? [...live, ...visibleRecent] : live;

  return (
    <section aria-label="Other agents" className="mt-2">
      <div className="mx-0.5 h-8">
        <CollapsibleSectionHeader
          expanded={expanded}
          onClick={toggleExpanded}
          accessory={<span className="shrink-0 tabular-nums">{entries.length}</span>}
        >
          Other agents
        </CollapsibleSectionHeader>
      </div>
      {expanded ? (
        <ul className="flex flex-col">
          {visible.map((entry) => {
            const key = rowKey(entry.environmentId, entry.session.key);
            return (
              <ExternalSessionRow
                key={key}
                entry={entry}
                isActive={activeKey === key}
                nowMinute={nowMinute}
                onNavigate={closeMobileSidebar}
              />
            );
          })}
          {hiddenRecentCount > 0 || recentShown > 0 ? (
            <li className="list-none">
              <button
                type="button"
                onClick={() =>
                  setRecentShown((shown) => (hiddenRecentCount > 0 ? shown + RECENT_PAGE_SIZE : 0))
                }
                className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              >
                {hiddenRecentCount > 0 ? (
                  <>
                    <PlusIcon aria-hidden className="size-4 shrink-0" />
                    Show {Math.min(hiddenRecentCount, RECENT_PAGE_SIZE)} more
                  </>
                ) : (
                  "Show less"
                )}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * One external session. `nowMinute` only exists to refresh the relative time
 * once a minute; the other props keep their identity across unrelated pushes.
 */
const ExternalSessionRow = memo(function ExternalSessionRow(props: {
  entry: ExternalSessionEntry;
  isActive: boolean;
  nowMinute: string;
  onNavigate: () => void;
}) {
  const { environmentId, environmentLabel, session } = props.entry;
  const title = externalSessionTitle(session);
  const providerLabel = formatProviderDriverKindLabel(session.driver);
  const meta = [session.model, session.origin, cwdBasename(session.cwd), environmentLabel]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");
  const age = formatRelativeTime(session.updatedAt)?.value ?? "";
  const label = [title, providerLabel, session.origin, LIVENESS_LABEL[session.liveness]]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(", ");

  return (
    <li className="list-none">
      <Link
        to="/external/$environmentId/$sessionKey"
        params={{ environmentId, sessionKey: session.key }}
        aria-label={label}
        aria-current={props.isActive ? "page" : undefined}
        onClick={props.onNavigate}
        className={cn(
          "group/sidebar-row flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <ProviderInstanceIcon
          driverKind={session.driver}
          displayName={providerLabel}
          iconClassName="size-4"
          indicatorBackground="var(--sidebar)"
          {...LIVENESS_DOT_PROPS[session.liveness]}
        />
        <span aria-hidden className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                props.isActive
                  ? "font-medium text-foreground"
                  : session.liveness === "recent"
                    ? "text-secondary-label/70 group-hover/sidebar-row:text-foreground"
                    : "font-medium text-foreground/90",
              )}
            >
              {title}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-secondary-label">{age}</span>
          </span>
          {meta.length > 0 ? (
            <span className="truncate text-xs text-secondary-label/80">{meta}</span>
          ) : null}
        </span>
      </Link>
    </li>
  );
});
