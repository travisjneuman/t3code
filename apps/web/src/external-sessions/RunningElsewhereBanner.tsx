/**
 * Composer warning for a continued external session that its own agent is
 * working in right now (externalSessionSync.ts on the server). Sending still
 * works; this only says the two would race. Fork add-on, mounted from
 * ChatView through one hook; see docs/internals/external-sessions.md.
 */
import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, PROVIDER_DISPLAY_NAMES, type ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { MonitorUpIcon } from "lucide-react";
import { useMemo } from "react";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { formatProviderDriverKindLabel } from "../providerModels";
import { environmentServerConfigsAtom } from "../state/server";
import { externalSessionsRunningElsewhere } from "./atoms";

// Continued threads are `import:<instance id>:<session id>`; no other thread can be in the set.
const CONTINUED_THREAD = /^import:([^:]+):/;
const KEY_SEPARATOR = "\u0000";

/** The agent's product name while the thread is running elsewhere, otherwise null. */
const runningElsewhereAgentAtom = Atom.family((key: string) => {
  const separator = key.indexOf(KEY_SEPARATOR);
  const environmentId = key.slice(0, separator) as EnvironmentId;
  const threadId = key.slice(separator + 1) as ThreadId;
  const instanceId = CONTINUED_THREAD.exec(threadId)?.[1] ?? null;
  return Atom.make((get): string | null => {
    // Other threads never open the stream.
    if (instanceId === null) return null;
    const running = Option.getOrNull(
      AsyncResult.value(get(externalSessionsRunningElsewhere({ environmentId, input: {} }))),
    );
    if (running === null || !running.threadIds.includes(threadId)) return null;
    const driver = get(environmentServerConfigsAtom)
      .get(environmentId)
      ?.providers.find((provider) => provider.instanceId === instanceId)?.driver;
    if (driver === undefined) return "its own app";
    return PROVIDER_DISPLAY_NAMES[driver] ?? formatProviderDriverKindLabel(driver);
  }).pipe(Atom.withLabel(`external-sessions:running-elsewhere:${threadId}`));
});

/**
 * `items` plus the warning while this thread's session runs in its own agent.
 * Returns `items` itself otherwise, so the composer sees no change.
 */
export function useRunningElsewhereBanner(
  items: ReadonlyArray<ComposerBannerStackItem>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<ComposerBannerStackItem> {
  const agent = useAtomValue(
    runningElsewhereAgentAtom(`${environmentId}${KEY_SEPARATOR}${threadId}`),
  );
  return useMemo<ReadonlyArray<ComposerBannerStackItem>>(
    () =>
      agent === null
        ? items
        : [
            ...items,
            {
              id: `external-session-running-elsewhere:${threadId}`,
              variant: "warning",
              icon: <MonitorUpIcon />,
              title: `Running in ${agent} outside T3 — wait for it to finish before sending here.`,
            },
          ],
    [agent, items, threadId],
  );
}
