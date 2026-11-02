/**
 * Settings › Archived: the upstream archived-threads page between the fork's
 * archived sections, which add-ons register in FORK_ARCHIVED_SECTIONS. Mounted
 * by the one-line import in routes/_chat.settings.archived.tsx.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { ComponentType } from "react";

import { ArchivedThreadsPanel as UpstreamArchivedThreadsPanel } from "./components/settings/ArchivedThreadsPanel";
import { useSettingsScope } from "./components/settings/SettingsScopeContext";
import { WorkspacePageContainer } from "./components/WorkspacePageContainer";
import { ArchivedExternalSessions } from "./external-sessions/ArchivedExternalSessions";
import { ArchivedHermesSessions } from "./hermes/ArchivedHermesSessions";
import { useArchivedThreadSnapshots } from "./lib/archivedThreadsState";
import { cn } from "./lib/utils";
import { useEnvironmentIdentities } from "./state/environments";
import { ThreadRetentionSections } from "./thread-retention/ThreadRetentionSections";

/** One environment's archived sessions from an agent's own store; renders null when it has none. */
type ArchivedSection = ComponentType<{
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
}>;

const FORK_ARCHIVED_SECTIONS: ReadonlyArray<readonly [key: string, ArchivedSection]> = [
  ["external", ArchivedExternalSessions], // Fork add-on(other-agents)
  ["hermes", ArchivedHermesSessions], // Fork add-on(hermes)
];

/**
 * Replaces the route's component. The upstream panel owns a scroll container;
 * it is flattened here so every list scrolls as one page.
 */
export function ArchivedThreadsPanel() {
  const { scope } = useSettingsScope();
  // Same atom family the upstream panel reads, so this adds no request.
  const t3Archive = useArchivedThreadSnapshots(scope.environmentIds);
  const t3ArchiveEmpty =
    !t3Archive.isLoading &&
    t3Archive.error === null &&
    t3Archive.snapshots.every(({ snapshot }) => snapshot.threads.length === 0);
  return (
    <div
      className={cn(
        "scrollbar-gutter-both topbar-scroll-fade flex min-h-0 flex-1 flex-col overflow-y-auto [&>[data-settings-page-scroll]]:flex-none [&>[data-settings-page-scroll]]:overflow-visible [&>[data-settings-page-scroll]]:[-webkit-mask-image:none] [&>[data-settings-page-scroll]]:[mask-image:none]",
        // The upstream panel would say "No archived threads" above archived rows. Sections
        // load inside their own components, so whether any rendered is read with :has().
        t3ArchiveEmpty &&
          "[&:has(>[data-fork-archived-sections]>*)>[data-settings-page-scroll]]:hidden",
      )}
    >
      <ThreadRetentionSections /> {/* Fork add-on(thread-retention) */}
      <UpstreamArchivedThreadsPanel />
      <ForkArchivedSections flushTop={!t3ArchiveEmpty} />
    </div>
  );
}

/** Agent session stores are per environment, not per project, so project scopes show none. */
function ForkArchivedSections(props: { readonly flushTop: boolean }) {
  const { scope } = useSettingsScope();
  const identities = useEnvironmentIdentities();
  if (scope.kind !== "all" && scope.kind !== "environment") return null;
  const labelFor = (environmentId: EnvironmentId) =>
    scope.environmentIds.length > 1
      ? (identities.find((identity) => identity.environmentId === environmentId)?.label ?? null)
      : null;
  return (
    <WorkspacePageContainer
      data-fork-archived-sections
      className={cn("gap-8", props.flushTop && "pt-0")}
    >
      {FORK_ARCHIVED_SECTIONS.flatMap(([key, Section]) =>
        scope.environmentIds.map((environmentId) => (
          <Section
            key={`${key}:${environmentId}`}
            environmentId={environmentId}
            environmentLabel={labelFor(environmentId)}
          />
        )),
      )}
    </WorkspacePageContainer>
  );
}
