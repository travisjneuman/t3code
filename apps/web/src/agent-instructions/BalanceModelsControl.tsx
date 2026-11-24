/**
 * The models T3 balances workers between by subscription pace. Fewer than two
 * means no balancing. Fork add-on: agent instructions.
 */
import type { ModelSelection } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";

import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { type PickerContext, WorkerModelPicker } from "./WorkerModelControl";

const sameModel = (left: ModelSelection, right: ModelSelection) =>
  left.instanceId === right.instanceId && left.model === right.model;

export function BalanceModelsControl({
  suggestions,
  ...picker
}: PickerContext & {
  /** What Add offers first: the first one not already in the list. */
  readonly suggestions: ReadonlyArray<ModelSelection | null>;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments } = useSettingsScope();
  const mixed = useScopedSettingsMixed(["agentWorkerBalanceModels"]);
  const models = settings.agentWorkerBalanceModels;

  const save = (next: ReadonlyArray<ModelSelection>) => {
    for (const value of next) {
      const reason = picker.modelDisabledReason(value.instanceId, value.model);
      if (reason) {
        toastManager.add({ type: "error", title: "Balance model not saved", description: reason });
        return;
      }
    }
    updateSettings({ agentWorkerBalanceModels: next });
  };

  if (connectedEnvironments.length === 0) {
    return (
      <span className="text-sm text-muted-foreground">
        Connect an environment to choose these models.
      </span>
    );
  }

  const nextModel = suggestions.find(
    (candidate): candidate is ModelSelection =>
      candidate !== null && !models.some((entry) => sameModel(entry, candidate)),
  );

  return (
    <div className="flex min-w-0 flex-col items-end gap-1.5">
      {models.map((model, index) => (
        <div
          key={`${model.instanceId}:${model.model}`}
          className="flex min-w-0 flex-wrap items-center justify-end gap-1.5"
        >
          <WorkerModelPicker
            stored={model}
            label={`Balance model ${index + 1}`}
            mixed={mixed}
            onChange={(value) => save(models.map((entry, at) => (at === index ? value : entry)))}
            {...picker}
          />
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove balance model ${index + 1}`}
            onClick={() => save(models.filter((_, at) => at !== index))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <Button
        size="xs"
        variant="outline"
        disabled={nextModel === undefined}
        onClick={() => {
          if (nextModel) save([...models, nextModel]);
        }}
      >
        <PlusIcon />
        Add model
      </Button>
    </div>
  );
}
