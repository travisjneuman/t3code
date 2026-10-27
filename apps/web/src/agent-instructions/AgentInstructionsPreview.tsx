/**
 * The Agents "What agents receive" button: shows the instruction text the
 * server builds from the settings picked in the scope picker, then the text
 * each provider's agents get on top.
 * Fork add-on: agent instructions.
 */
import {
  AGENT_PROJECT_SCOPED_SETTING_KEYS,
  agentPresetForThread,
  applyAgentThreadPreset,
  buildAgentInstructionsText,
  PROVIDER_DISPLAY_NAMES,
} from "@t3tools/contracts";

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
  // A thread without a preset choice runs under the default preset, so show that.
  const settings = applyAgentThreadPreset(useScopedSettings(), []);
  const defaultPreset = agentPresetForThread(settings, []);
  const mixed = useScopedSettingsMixed(AGENT_PROJECT_SCOPED_SETTING_KEYS);
  const text = buildAgentInstructionsText(settings);
  const providerTexts = Object.entries(settings.agentProviderInstructions).filter(
    ([, providerText]) => providerText !== "",
  );

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
            task.{" "}
            {defaultPreset
              ? `This includes the default preset, ${defaultPreset.name}, which threads without a preset choice run under. A thread that picks another preset gets its values instead.`
              : "A thread running under a preset gets that preset's values instead."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {text === "" && providerTexts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing. With these settings agents get no added instructions.
            </p>
          ) : null}
          {text === "" ? null : (
            <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">
              {text}
            </pre>
          )}
          {providerTexts.map(([kind, providerText]) => (
            <div key={kind} className="flex flex-col gap-1.5">
              <p className="text-sm text-muted-foreground">
                Then only{" "}
                {PROVIDER_DISPLAY_NAMES[kind as keyof typeof PROVIDER_DISPLAY_NAMES] ?? kind} agents
                get:
              </p>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">
                {providerText}
              </pre>
            </div>
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
