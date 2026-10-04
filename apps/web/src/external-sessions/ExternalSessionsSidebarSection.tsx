import { useAtomValue } from "@effect/atom-react";
import { Link, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CircleDashedIcon, PlusIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { useSidebar } from "../components/ui/sidebar";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  cwdBasename,
  externalSessionEntriesAtom,
  externalSessionOriginLabel,
  externalSessionProductName,
  externalSessionTitle,
  LIVENESS_LABEL,
  shortModelLabel,
  type ExternalSessionEntry,
} from "./atoms";

const EXPANDED_STORAGE_KEY = "t3code:sidebar:external-sessions-expanded";
/** How many inactive sessions each "Show more" reveals. */
const RECENT_PAGE_SIZE = 20;

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

/** Matches the standard thread rows' short relative time: "5m", "now". */
function compactTimeLabel(iso: string): string {
  const label = formatRelativeTimeLabel(iso);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/**
 * One external session, in the standard thread row's type scale and surfaces:
 * title and status on top, then provider, folder and model. Inactive sessions
 * recede the way settled threads do. `nowMinute` only exists to refresh the
 * relative time once a minute; the other props keep their identity across
 * unrelated pushes.
 */
const ExternalSessionRow = memo(function ExternalSessionRow(props: {
  entry: ExternalSessionEntry;
  isActive: boolean;
  nowMinute: string;
  onNavigate: () => void;
}) {
  const { environmentId, environmentLabel, session } = props.entry;
  const title = externalSessionTitle(session);
  const providerLabel = externalSessionProductName(session);
  const folder = cwdBasename(session.cwd);
  const model = shortModelLabel(session.model);
  const recede = session.liveness === "recent";
  const running = session.liveness === "running";
  const label = [
    title,
    externalSessionOriginLabel(session),
    folder,
    model,
    LIVENESS_LABEL[session.liveness],
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(", ");

  return (
    <li className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_58px]">
      <Link
        to="/external/$environmentId/$sessionKey"
        params={{ environmentId, sessionKey: session.key }}
        aria-label={label}
        aria-current={props.isActive ? "page" : undefined}
        onClick={props.onNavigate}
        title={session.cwd === null ? title : `${title}\n${session.cwd}`}
        className={cn(
          "group/sidebar-row relative block w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : recede
              ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <span
          aria-hidden
          className="relative z-10 block px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)"
        >
          <span className="flex h-5 min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                recede && !props.isActive
                  ? "font-normal text-secondary-label"
                  : "font-medium text-foreground/90",
              )}
            >
              {title}
            </span>
            <span className="ml-auto flex h-5 min-w-8 shrink-0 items-center justify-end text-xs tabular-nums text-secondary-label">
              {running ? (
                <span className="inline-flex items-center gap-1 font-medium text-info">
                  <CircleDashedIcon className="size-4 shrink-0" />
                  Running
                </span>
              ) : (
                compactTimeLabel(session.updatedAt)
              )}
            </span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-secondary-label">
            <ProviderInstanceIcon
              driverKind={session.driver}
              displayName={providerLabel}
              className="size-3.5 shrink-0"
              iconClassName="size-3.5"
            />
            <span className="min-w-0 truncate">
              {folder ?? externalSessionOriginLabel(session)}
            </span>
            {model !== null ? (
              <span className="min-w-0 shrink-[2] truncate text-muted-foreground/60">{model}</span>
            ) : null}
            {environmentLabel !== null ? (
              <span className="ml-auto min-w-0 shrink-[3] truncate text-muted-foreground/60">
                {environmentLabel}
              </span>
            ) : null}
          </span>
        </span>
      </Link>
    </li>
  );
});
