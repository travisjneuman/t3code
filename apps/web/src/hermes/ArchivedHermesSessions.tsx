/**
 * Hermes sessions archived from T3, listed in Settings › Archived so each can
 * come back. Fork add-on: Hermes provider.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, HermesArchivedSession } from "@t3tools/contracts";
import { ArchiveX } from "lucide-react";
import { useEffect, useState } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { useNowMinute } from "../hooks/useNowMinute";
import { useStableCallback } from "../hooks/useStableCallback";
import { environmentServerConfigsAtom } from "../state/server";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  HERMES_DRIVER,
  hermesAgentName,
  hermesInstanceIds,
  hermesSessionsListArchived,
  hermesSessionsUnarchive,
  runHermes,
} from "./hermesSessions";

export function ArchivedHermesSessions(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
}) {
  const { environmentId } = props;
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const config = useAtomValue(environmentServerConfigsAtom).get(environmentId);
  const instanceIds = hermesInstanceIds(config);
  const hasHermes = instanceIds.length > 0;
  const names = new Set(
    instanceIds.map((instanceId) => hermesAgentName(config?.settings, instanceId)),
  );
  const agentName = names.size === 1 ? ([...names][0] ?? "Hermes") : "Hermes";
  const [sessions, setSessions] = useState<ReadonlyArray<HermesArchivedSession>>([]);
  const [pending, setPending] = useState<string | null>(null);
  const mayUnarchive = useAtomValue(hermesSessionsUnarchive.permissionAtom(environmentId));

  const load = useStableCallback(async () => {
    const result = await runHermes(
      hermesSessionsListArchived,
      environmentId,
      {},
      "Could not list archived Hermes sessions",
    );
    if (result !== null) setSessions(result.sessions);
  });

  useEffect(() => {
    if (hasHermes) void load();
  }, [environmentId, hasHermes, load]);

  if (!hasHermes || sessions.length === 0) return null;

  const unarchive = async (session: HermesArchivedSession) => {
    setPending(session.id);
    const result = await runHermes(
      hermesSessionsUnarchive,
      environmentId,
      { instanceId: session.instanceId, sessionId: session.id },
      "Failed to unarchive session",
    );
    setPending(null);
    if (result !== null) await load();
  };

  return (
    <SettingsSection
      title={
        props.environmentLabel === null ? agentName : `${agentName} · ${props.environmentLabel}`
      }
    >
      {sessions.map((session) => (
        <SettingsRow
          key={`${session.instanceId}:${session.id}`}
          title={session.title || session.id}
          description={
            <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
              <ProviderInstanceIcon
                driverKind={HERMES_DRIVER}
                displayName={agentName}
                className="size-3.5 shrink-0"
                iconClassName="size-3.5"
              />
              <span>{`Archived ${formatRelativeTimeLabel(session.archivedAt, now)}`}</span>
            </span>
          }
          control={
            mayUnarchive ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                disabled={pending !== null}
                onClick={() => void unarchive(session)}
              >
                <ArchiveX className="size-3.5" />
                <span>Unarchive</span>
              </Button>
            ) : null
          }
        />
      ))}
    </SettingsSection>
  );
}
