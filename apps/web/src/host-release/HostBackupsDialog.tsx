import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  HOST_BACKUPS_WS_METHODS,
  type HostBackupEntry,
} from "@t3tools/contracts";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";
import { formatRelativeTimeLabel } from "~/timestampFormat";

// Idle TTL 0: the listing reads the host's disk, so it runs only while the dialog is open and
// is read fresh each time it opens.
const hostBackupsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:host-backups:list",
  tag: HOST_BACKUPS_WS_METHODS.list,
  idleTtlMs: 0,
});

const KIND_LABELS: Record<HostBackupEntry["kind"], string> = {
  cold: "Cold backup",
  "pre-fork": "Pre-fork backup",
  unrecognized: "Unrecognized",
};

function describeBackup(backup: HostBackupEntry): string {
  const parts = [KIND_LABELS[backup.kind]];
  if (backup.restoresVersion !== null) parts.push(`restores t3@${backup.restoresVersion}`);
  if (backup.createdAt !== null) {
    const relative = formatRelativeTimeLabel(backup.createdAt);
    if (relative !== "") parts.push(`made ${relative}`);
  }
  return parts.join(" · ");
}

function BackupRow({ backup }: { readonly backup: HostBackupEntry }) {
  return (
    <li className="min-w-0 space-y-0.5 py-2">
      <div className="truncate font-mono text-xs">{backup.name}</div>
      <div className="text-muted-foreground text-xs">{describeBackup(backup)}</div>
      {backup.problem === null ? null : (
        <div className="text-destructive text-xs">{backup.problem}</div>
      )}
    </li>
  );
}

function HostBackupsList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(hostBackupsQuery({ environmentId, input: {} }));
  if (query.error !== null) {
    return <p className="text-destructive text-sm">{query.error}</p>;
  }
  if (query.data === null) {
    return <p className="text-muted-foreground text-sm">Reading backups…</p>;
  }
  const { backups, stagingCount } = query.data;
  return (
    <div className="space-y-3">
      {backups.length === 0 ? (
        <p className="text-muted-foreground text-sm">No backups on this host.</p>
      ) : (
        <ul className="divide-y">
          {backups.map((backup) => (
            <BackupRow key={backup.name} backup={backup} />
          ))}
        </ul>
      )}
      {stagingCount === 0 ? null : (
        <p className="text-muted-foreground text-xs">
          {stagingCount === 1
            ? "1 interrupted backup copy is also present."
            : `${stagingCount} interrupted backup copies are also present.`}
        </p>
      )}
    </div>
  );
}

/** Mount only while open: mounting is what reads the host's backups. */
export function HostBackupsDialog({
  environmentId,
  serverLabel,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Backups on {serverLabel}</DialogTitle>
          <DialogDescription>
            What the host tooling keeps under its T3 home, and the version each would restore.
            Restoring is done on the host.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <HostBackupsList environmentId={environmentId} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
