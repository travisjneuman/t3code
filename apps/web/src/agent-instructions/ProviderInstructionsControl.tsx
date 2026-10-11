/**
 * The Agents "Provider instructions" row body: pick a provider, then write text
 * only its agents receive, after the additional instructions. Entries are keyed
 * by driver kind, so every instance of a provider shares one text.
 * Fork add-on: agent instructions.
 */
import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";
import { useRef, useState } from "react";

import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Textarea } from "../components/ui/textarea";
import { ChoiceSelect } from "./ChoiceSelect";

/** Installed provider kinds, plus any that already have text. Antigravity is left out. */
function providerKinds(
  providers: ReadonlyArray<ServerProvider>,
  instructions: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
  const kinds = new Set<string>(providers.map((provider) => provider.driver));
  for (const [kind, text] of Object.entries(instructions)) if (text !== "") kinds.add(kind);
  kinds.delete("antigravity");
  return [...kinds];
}

export function ProviderInstructionsControl({
  providers,
  scopeKey,
}: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly scopeKey: string;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["agentProviderInstructions"]);
  const kinds = providerKinds(providers, settings.agentProviderInstructions);
  const [picked, setPicked] = useState<string | null>(null);
  const kind = picked !== null && kinds.includes(picked) ? picked : (kinds[0] ?? null);
  const edited = useRef(false);
  if (kind === null) {
    return <p className="mt-3 pb-3.5 text-sm text-muted-foreground">No providers are set up.</p>;
  }
  const current = settings.agentProviderInstructions[kind] ?? "";
  const labelOf = (candidate: string) =>
    PROVIDER_DISPLAY_NAMES[candidate as keyof typeof PROVIDER_DISPLAY_NAMES] ?? candidate;

  return (
    <div className="mt-3 flex max-w-2xl flex-col gap-2 pb-3.5">
      <ChoiceSelect
        value={kind}
        options={kinds.map((candidate) => {
          const filled = (settings.agentProviderInstructions[candidate] ?? "") !== "";
          return [candidate, `${labelOf(candidate)}${filled ? " •" : ""}`] as const;
        })}
        ariaLabel="Provider"
        onChange={setPicked}
      />
      <Textarea
        key={`${scopeKey}:${mixed}:${kind}:${current}`}
        aria-label={`${labelOf(kind)} instructions`}
        rows={3}
        defaultValue={mixed ? "" : current}
        placeholder={
          mixed
            ? "Mixed. Enter instructions to apply to all selected targets."
            : `Only ${labelOf(kind)} agents get this text.`
        }
        onChange={() => {
          edited.current = true;
        }}
        onBlur={(event) => {
          const next = event.target.value.trim();
          if (edited.current && (mixed || next !== current)) {
            // Records merge on save, so an empty string clears this provider's entry.
            updateSettings({ agentProviderInstructions: { [kind]: next } });
          }
          edited.current = false;
        }}
      />
    </div>
  );
}
