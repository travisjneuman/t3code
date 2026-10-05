/**
 * Settings › Archived for Other Agents sessions: the upstream archived-threads
 * page with archived external sessions below it, each with Unarchive, except
 * sessions archived in Claude desktop, which only Claude can restore. Mounted
 * by the one-line import in routes/settings.archived.tsx. Fork add-on; see
 * docs/internals/external-sessions.md.
 *
 * @module external-sessions/ArchivedExternalSessions
 */
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ExternalSessionArchivedSession,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { ArchiveX } from "lucide-react";
import { useState } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { ArchivedThreadsPanel as UpstreamArchivedThreadsPanel } from "../components/settings/SettingsPanels";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { formatProviderDriverKindLabel } from "../providerModels";
import { useEnvironmentIdentities } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cwdBasename, externalSessionUnarchive, externalSessionsArchived } from "./atoms";

/**
 * Replaces the route's component. The upstream panel owns a scroll container;
 * it is flattened here so both lists scroll as one page.
 */
export function ArchivedThreadsPanel() {
  return (
    <div className="scrollbar-gutter-both topbar-scroll-fade flex min-h-0 flex-1 flex-col overflow-y-auto [&>[data-settings-page-scroll]]:flex-none [&>[data-settings-page-scroll]]:overflow-visible [&>[data-settings-page-scroll]]:[-webkit-mask-image:none] [&>[data-settings-page-scroll]]:[mask-image:none]">
      <UpstreamArchivedThreadsPanel />
      <ArchivedExternalSessions />
    </div>
  );
}

/** External sessions are per environment, not per project, so project scopes show none. */
function ArchivedExternalSessions() {
  const { scope } = useSettingsScope();
  const identities = useEnvironmentIdentities();
  if (scope.kind !== "all" && scope.kind !== "environment") return null;
  const labelFor = (environmentId: EnvironmentId) =>
    scope.environmentIds.length > 1
      ? (identities.find((identity) => identity.environmentId === environmentId)?.label ?? null)
      : null;
  return (
    <WorkspacePageContainer className="gap-8 pt-0">
      {scope.environmentIds.map((environmentId) => (
        <EnvironmentArchivedSessions
          key={environmentId}
          environmentId={environmentId}
          environmentLabel={labelFor(environmentId)}
        />
      ))}
    </WorkspacePageContainer>
  );
}

function EnvironmentArchivedSessions(props: {
  environmentId: EnvironmentId;
  environmentLabel: string | null;
}) {
  const { environmentId, environmentLabel } = props;
  const archived = Option.getOrNull(
    AsyncResult.value(useAtomValue(externalSessionsArchived({ environmentId, input: {} }))),
  );
  if (archived === null || archived.sessions.length === 0) return null;
  return (
    <SettingsSection
      title={environmentLabel === null ? "Other Agents" : `Other Agents · ${environmentLabel}`}
    >
      {archived.sessions.map((session) => (
        <ArchivedSessionRow key={session.key} environmentId={environmentId} session={session} />
      ))}
    </SettingsSection>
  );
}

function ArchivedSessionRow(props: {
  environmentId: EnvironmentId;
  session: ExternalSessionArchivedSession;
}) {
  const { environmentId, session } = props;
  const runUnarchive = useAtomCommand(externalSessionUnarchive, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const productName =
    PROVIDER_DISPLAY_NAMES[session.driver] ?? formatProviderDriverKindLabel(session.driver);
  const folder = cwdBasename(session.cwd);
  // Mirrored from the Claude app, read-only: only Claude can unarchive it.
  const inClaudeDesktop = session.archivedIn === "claudeDesktop";

  // The row leaves on the server's next push, once the session is back in the sidebar.
  const unarchive = async () => {
    setPending(true);
    const result = await runUnarchive({ environmentId, input: { key: session.key } });
    setPending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Failed to unarchive session",
        description: failure instanceof Error ? failure.message : "An error occurred.",
      });
      return;
    }
    if (result.value.warning !== null) {
      toastManager.add({
        type: "warning",
        title: "Unarchived in T3",
        description: `${productName} could not restore it: ${result.value.warning}`,
      });
    }
  };

  return (
    <SettingsRow
      title={session.title.length > 0 ? session.title : "Untitled session"}
      description={
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
          <ProviderInstanceIcon
            driverKind={session.driver}
            displayName={productName}
            className="size-3.5 shrink-0"
            iconClassName="size-3.5"
          />
          <span>
            {[
              productName,
              folder,
              `${inClaudeDesktop ? "Archived in Claude desktop" : "Archived"} ${formatRelativeTimeLabel(session.archivedAt)}`,
            ]
              .filter((part): part is string => part !== null && part.length > 0)
              .join(" · ")}
          </span>
        </span>
      }
      control={
        inClaudeDesktop ? (
          <span className="shrink-0 text-muted-foreground text-xs">Unarchive it in Claude</span>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            disabled={pending}
            onClick={() => void unarchive()}
          >
            <ArchiveX className="size-3.5" />
            <span>Unarchive</span>
          </Button>
        )
      }
    />
  );
}
