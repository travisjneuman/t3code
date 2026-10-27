/**
 * Pairs another device, such as a phone, directly with a remote environment: mints a pairing
 * credential on that environment and shows it as a link and QR for one of its own addresses.
 * Fork add-on: pair remote devices.
 */
import { useAtomValue } from "@effect/atom-react";
import { mintRemotePairingCredential } from "@t3tools/client-runtime/state/remotePairing";
import type { EnvironmentId, ServerDirectEndpoint } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { resolveDesktopPairingUrl } from "~/components/settings/pairingUrls";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { QRCodeSvg } from "~/components/ui/qr-code";
import { toastManager } from "~/components/ui/toast";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { formatEnvironmentQueryError } from "~/state/query";
import { environmentSession } from "~/state/session";

/** Tailscale Serve HTTPS first, then the tailnet address, then the local network. */
export function pairingEndpointUrl(
  endpoints: ReadonlyArray<ServerDirectEndpoint> | undefined,
): string | null {
  const rank = (endpoint: ServerDirectEndpoint) =>
    endpoint.kind === "lan" ? 2 : endpoint.httpBaseUrl.startsWith("https:") ? 0 : 1;
  return endpoints?.toSorted((a, b) => rank(a) - rank(b))[0]?.httpBaseUrl ?? null;
}

// Unmounting the dialog drops the atom, so each opening mints a fresh credential.
const remotePairingCredentialAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get.once(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.fail(new Error("Not connected to this machine."));
      return mintRemotePairingCredential({ prepared, label: "Paired device" });
    })
    .pipe(Atom.withLabel(`remote-pairing-credential:${environmentId}`)),
);

function PairingLink({
  environmentId,
  endpointUrl,
}: {
  readonly environmentId: EnvironmentId;
  readonly endpointUrl: string;
}) {
  const result = useAtomValue(remotePairingCredentialAtom(environmentId));
  const { copyToClipboard } = useCopyToClipboard({
    target: "pairing link",
    onCopy: () => toastManager.add({ type: "success", title: "Pairing link copied" }),
  });
  if (AsyncResult.isFailure(result)) {
    return <p className="text-destructive text-sm">{formatEnvironmentQueryError(result.cause)}</p>;
  }
  if (!AsyncResult.isSuccess(result)) {
    return <p className="text-muted-foreground text-sm">Creating a pairing link…</p>;
  }
  const pairingUrl = resolveDesktopPairingUrl(endpointUrl, result.value.credential);
  const expiresAt = new Date(DateTime.toEpochMillis(result.value.expiresAt)).toLocaleTimeString(
    [],
    {
      hour: "numeric",
      minute: "2-digit",
    },
  );
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="w-fit rounded-xl bg-white p-3">
        <QRCodeSvg
          value={pairingUrl}
          size={192}
          level="M"
          marginSize={1}
          title="Pairing link. Scan to open on another device"
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Works once, until {expiresAt}. Pairs with {endpointUrl}.
      </p>
      <Button size="xs" variant="outline" onClick={() => copyToClipboard(pairingUrl, undefined)}>
        Copy link
      </Button>
    </div>
  );
}

/** Mount only while open: mounting is what mints the credential. */
export function RemotePairingDialog({
  environmentId,
  serverLabel,
  endpointUrl,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly endpointUrl: string;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Pair a device with {serverLabel}</DialogTitle>
          <DialogDescription>
            Scan with the T3 Code mobile app, or open the link on another device, to add{" "}
            {serverLabel} as its own environment there.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <PairingLink environmentId={environmentId} endpointUrl={endpointUrl} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
