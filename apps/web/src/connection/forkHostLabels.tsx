import { useAtomValue } from "@effect/atom-react";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect } from "react";

import { environmentPresentations } from "../state/presentation";
import { useAtomCommand } from "../state/use-atom-command";
import { connectionAtomRuntime } from "./runtime";

const relabelEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:relabel",
  scheduler: createAtomCommandScheduler(),
  concurrency: { mode: "serial", key: () => "relabel" },
  execute: (input: { readonly environmentId: EnvironmentId; readonly label: string }) =>
    EnvironmentRegistry.EnvironmentRegistry.pipe(
      Effect.flatMap((registry) =>
        registry.relabel === undefined
          ? Effect.void
          : registry.relabel(input.environmentId, input.label),
      ),
    ),
});

/**
 * Web pairing always saves the host's own name, so a saved environment follows the name its
 * connected server reports. A renamed host shows its new name here after its next connection.
 */
export function HostLabelSync() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const relabel = useAtomCommand(relabelEnvironment, { reportFailure: false });
  const renamed = [...presentations].flatMap(([environmentId, presentation]) => {
    const reported = presentation.serverConfig?.environment.label;
    return presentation.connection.phase === "connected" &&
      presentation.entry.target._tag !== "PrimaryConnectionTarget" &&
      reported !== undefined &&
      reported !== presentation.entry.target.label
      ? [{ environmentId, label: reported }]
      : [];
  });
  // Presentations change on every status push; only a changed name list reruns the effect.
  const key = JSON.stringify(renamed);
  useEffect(() => {
    for (const input of renamed) void relabel(input);
  }, [key]);
  return null;
}
