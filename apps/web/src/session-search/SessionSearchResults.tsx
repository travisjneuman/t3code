/**
 * "Other Agents" group under the sidebar's thread search results: sessions
 * from Claude Code, Codex, Grok, Pi, and Antigravity whose messages match the
 * query. Opening one shows it on the external session route. Fork add-on.
 */
import { PROVIDER_DISPLAY_NAMES, type SessionSearchSnippet } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { memo, useCallback, useState } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { useSidebar } from "../components/ui/sidebar";
import { externalSessionTitle } from "../external-sessions/atoms";
import { useNowMinute } from "../hooks/useNowMinute";
import { formatProviderDriverKindLabel } from "../providerModels";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { type SessionSearchEntry, useSessionSearch } from "./atoms";

const SOURCE_LABEL = {
  user: "You:",
  assistant: "Agent:",
  title: "Title:",
} as const satisfies Record<SessionSearchSnippet["source"], string>;

function folderName(cwd: string | null): string | null {
  if (cwd === null) return null;
  return (
    cwd
      .split(/[\\/]+/)
      .filter((segment) => segment.length > 0)
      .at(-1) ?? cwd
  );
}

/** Matches the standard thread rows' short relative time: "5m", "now". */
function compactTimeLabel(iso: string): string {
  const label = formatRelativeTimeLabel(iso);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/**
 * Renders nothing until a search returns sessions, so the thread results
 * above stay the whole view for a query no other agent matches.
 */
export function SessionSearchResults(props: { query: string }) {
  const search = useSessionSearch(props.query);
  const [expanded, setExpanded] = useState(true);
  const nowMinute = useNowMinute();
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (search.entries.length === 0) return null;

  const status = search.isPending ? "Searching…" : search.complete ? null : "Partial";
  return (
    <section aria-label="Other Agents search results" className="mt-2">
      <div className="mx-0.5 h-8">
        <CollapsibleSectionHeader
          expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          accessory={
            status === null ? null : (
              <span
                role="status"
                title={
                  search.isPending
                    ? undefined
                    : "The search hit its time limit; older sessions may be missing."
                }
                className="shrink-0 text-3xs text-sidebar-muted-foreground/60"
              >
                {status}
              </span>
            )
          }
        >
          {`Other Agents (${search.entries.length})`}
        </CollapsibleSectionHeader>
      </div>
      {expanded ? (
        <ul className="flex flex-col">
          {search.entries.map((entry) => (
            <SessionSearchRow
              key={`${entry.environmentId}\u0000${entry.hit.key}`}
              entry={entry}
              nowMinute={nowMinute}
              onNavigate={closeMobileSidebar}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function SnippetText(props: { snippet: SessionSearchSnippet }) {
  const { text, matchStart, matchEnd, source } = props.snippet;
  const isUser = source === "user";
  return (
    <span className="truncate text-xs text-muted-foreground/85">
      <span className={isUser ? "text-info-foreground" : "text-success-foreground"}>
        {SOURCE_LABEL[source]}
      </span>{" "}
      {text.slice(0, matchStart)}
      <mark className="bg-transparent font-semibold text-foreground">
        {text.slice(matchStart, matchEnd)}
      </mark>
      {text.slice(matchEnd)}
    </span>
  );
}

/** `nowMinute` only exists to refresh the relative time once a minute. */
const SessionSearchRow = memo(function SessionSearchRow(props: {
  entry: SessionSearchEntry;
  nowMinute: string;
  onNavigate: () => void;
}) {
  const { environmentId, environmentLabel, hit } = props.entry;
  const title = externalSessionTitle(hit);
  const product = PROVIDER_DISPLAY_NAMES[hit.driver] ?? formatProviderDriverKindLabel(hit.driver);
  const folder = folderName(hit.cwd);
  const label = [title, product, folder, environmentLabel]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(", ");

  return (
    <li className="list-none py-0.5">
      <Link
        to="/external/$environmentId/$sessionKey"
        params={{ environmentId, sessionKey: hit.key }}
        aria-label={label}
        onClick={props.onNavigate}
        title={hit.cwd === null ? title : `${title}\n${hit.cwd}`}
        className="relative block w-full cursor-pointer overflow-hidden rounded-md text-left text-sidebar-foreground outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span
          aria-hidden
          className="block px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)"
        >
          <span className="flex h-5 min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
              {title}
            </span>
            <span className="ml-auto shrink-0 text-xs tabular-nums text-secondary-label">
              {compactTimeLabel(hit.updatedAt)}
            </span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-secondary-label">
            <ProviderInstanceIcon
              driverKind={hit.driver}
              displayName={product}
              className="size-3.5 shrink-0"
              iconClassName="size-3.5"
            />
            <span className="min-w-0 truncate">{folder ?? product}</span>
            {environmentLabel !== null ? (
              <span className="ml-auto min-w-0 shrink-[3] truncate text-muted-foreground/60">
                {environmentLabel}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 flex min-w-0">
            <SnippetText snippet={hit.snippet} />
          </span>
        </span>
      </Link>
    </li>
  );
});
