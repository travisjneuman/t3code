/**
 * Archived Other Agents sessions for Settings › Archived (forkArchivedPanel.tsx),
 * each with Unarchive, except sessions archived in Claude desktop, which only
 * Claude can restore, and Delete where the agent's store allows it. Fork
 * add-on; see docs/internals/external-sessions.md.
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
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { formatProviderDriverKindLabel } from "../providerModels";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  cwdBasename,
  externalSessionDelete,
  externalSessionTitle,
  externalSessionUnarchive,
  externalSessionsArchived,
} from "./atoms";

/** One environment's archived Other Agents sessions; null when it has none. */
export function ArchivedExternalSessions(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
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
