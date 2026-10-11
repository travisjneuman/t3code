/**
 * The Agents "What agents receive" button: shows the instruction text the
 * server builds from the settings picked in the scope picker.
 * Fork add-on: agent instructions.
 */
import { AGENT_PROJECT_SCOPED_SETTING_KEYS, buildAgentInstructionsText } from "@t3tools/contracts";

import {
  useScopedSettings,
  useScopedSettingsMixed,
} from "../components/settings/useScopedSettings";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";

export function AgentInstructionsPreview() {
  const settings = useScopedSettings();
  const mixed = useScopedSettingsMixed(AGENT_PROJECT_SCOPED_SETTING_KEYS);
  const text = buildAgentInstructionsText(settings);

  return (
    <Dialog>
      <DialogTrigger render={<Button size="xs" variant="outline" />}>Preview</DialogTrigger>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>What agents receive</DialogTitle>
          <DialogDescription>
            {mixed
              ? "The selected targets differ; this is the first one. "
              : "For the scope picked above. "}
            Read-only review and research workers also get a read-only line at the top of their
            task.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {text === "" ? (
            <p className="text-sm text-muted-foreground">
              Nothing. With these settings agents get no added instructions.
            </p>
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">
              {text}
            </pre>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
