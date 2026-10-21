/**
 * Settings › Archived for Other Agents sessions: the upstream archived-threads
 * page with archived external sessions below it, each with Unarchive, except
 * sessions archived in Claude desktop, which only Claude can restore, and
 * Delete where the agent's store allows it. Mounted
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
  externalSessionDeletable,
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ExternalSessionArchivedSession,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ArchiveX, Trash2 } from "lucide-react";
import { useState } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { ArchivedThreadsPanel as UpstreamArchivedThreadsPanel } from "../components/settings/ArchivedThreadsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { ArchivedHermesSessions } from "../hermes/ArchivedHermesSessions"; // Fork add-on: Hermes provider.
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { formatProviderDriverKindLabel } from "../providerModels";
import { useEnvironmentIdentities } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  cwdBasename,
  externalSessionDelete,
  externalSessionTitle,
  externalSessionUnarchive,
  externalSessionsArchived,
} from "./atoms";

/**
 * Replaces the route's component. The upstream panel owns a scroll container;
 * it is flattened here so both lists scroll as one page.
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
        // The upstream panel would say "No archived threads" above archived rows. Hermes rows
        // load inside their own component, so whether any section rendered is read with :has().
        t3ArchiveEmpty &&
          "[&:has(>[data-archived-external-sessions]>*)>[data-settings-page-scroll]]:hidden",
      )}
    >
      <UpstreamArchivedThreadsPanel />
      <ArchivedExternalSessions flushTop={!t3ArchiveEmpty} />
    </div>
  );
}

/** External sessions are per environment, not per project, so project scopes show none. */
function ArchivedExternalSessions(props: { readonly flushTop: boolean }) {
  const { scope } = useSettingsScope();
  const identities = useEnvironmentIdentities();
  if (scope.kind !== "all" && scope.kind !== "environment") return null;
  const labelFor = (environmentId: EnvironmentId) =>
    scope.environmentIds.length > 1
      ? (identities.find((identity) => identity.environmentId === environmentId)?.label ?? null)
      : null;
  return (
    <WorkspacePageContainer
      data-archived-external-sessions
      className={cn("gap-8", props.flushTop && "pt-0")}
    >
      {scope.environmentIds.map((environmentId) => (
        <EnvironmentArchivedSessions
          key={environmentId}
          environmentId={environmentId}
          environmentLabel={labelFor(environmentId)}
        />
      ))}
      {/* Fork add-on: Hermes provider. */}
      {scope.environmentIds.map((environmentId) => (
        <ArchivedHermesSessions
          key={`hermes:${environmentId}`}
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
  const canUnarchive = useAtomValue(externalSessionUnarchive.permissionAtom(environmentId));
  const runDelete = useAtomCommand(externalSessionDelete, { reportFailure: false });
  const canDelete =
    useAtomValue(externalSessionDelete.permissionAtom(environmentId)) &&
    externalSessionDeletable(session);
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

  // Gone from the agent's own app too; the row leaves on the server's next push.
  const deleteSession = async () => {
    const api = readLocalApi();
    if (api === undefined) return;
    const confirmed = await api.dialogs
      .confirm(
        [
          `Delete "${externalSessionTitle(session)}"?`,
          `This deletes the session in ${productName} too. It cannot be undone.`,
        ].join("\n"),
        { variant: "destructive" },
      )
      .catch(() => false);
    if (!confirmed) return;
    setPending(true);
    const result = await runDelete({ environmentId, input: { key: session.key } });
    setPending(false);
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not delete session",
      description: failure instanceof Error ? failure.message : "An error occurred.",
    });
  };

  return (
    <SettingsRow
      title={externalSessionTitle(session)}
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
        <div className="flex shrink-0 items-center gap-2">
          {inClaudeDesktop ? (
            <span className="text-muted-foreground text-xs">Unarchive it in Claude</span>
          ) : !canUnarchive ? null : (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={pending}
              onClick={() => void unarchive()}
            >
              <ArchiveX className="size-3.5" />
              <span>Unarchive</span>
            </Button>
          )}
          {canDelete ? (
            <Button
              type="button"
              variant="destructive-outline"
              size="xs"
              disabled={pending}
              onClick={() => void deleteSession()}
            >
              <Trash2 className="size-3.5" />
              <span>Delete</span>
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
