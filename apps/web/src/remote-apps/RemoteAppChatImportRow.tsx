import type { DesktopRemoteAppBridge, RemoteAppChatImportResult } from "@t3tools/contracts";
import { useState } from "react";

import { SettingsRow } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";

const reportImport = (result: RemoteAppChatImportResult): void => {
  if (result.status === "canceled") return;
  if (result.status === "failed") {
    toastManager.add({
      type: "error",
      title: "Couldn't import chats",
      description: result.message,
    });
    return;
  }
  const count = `${result.conversations} conversation${result.conversations === 1 ? "" : "s"}`;
  toastManager.add({
    type: "success",
    title: `Imported ${count} from ${result.source}`,
    description: `Saved as Markdown in ${result.folder}`,
  });
};

/**
 * Turns an official ChatGPT, Claude, or Open WebUI chat export the user
 * downloaded into Markdown files. The desktop shell asks for the export and a
 * destination and does the work; this row only starts it and reports back.
 */
export function RemoteAppChatImportRow({ bridge }: { readonly bridge: DesktopRemoteAppBridge }) {
  const [importing, setImporting] = useState(false);
  // An older desktop shell has no importer.
  if (typeof bridge.importChatExport !== "function") return null;

  const startImport = () => {
    setImporting(true);
    void bridge
      .importChatExport()
      .then(reportImport, () =>
        reportImport({ status: "failed", message: "The desktop app couldn't run the import." }),
      )
      .finally(() => setImporting(false));
  };

  return (
    <SettingsRow
      title="Import chat export"
      description="Turns a ChatGPT or Claude data export (conversations.json) or an Open WebUI chat export into one Markdown file per conversation."
      control={
        <Button size="sm" variant="outline" disabled={importing} onClick={startImport}>
          {importing ? "Importing…" : "Import…"}
        </Button>
      }
    />
  );
}
