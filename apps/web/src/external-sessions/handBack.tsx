/**
 * Threads continued from another app: the sidebar row's marker, the hover
 * card's "Continued from" line, and two ways back in the thread menus. "Hand
 * back to <agent>", shown while the thread is set to a different agent, sends
 * one short message on the original agent and model, so the other app's
 * session gets what the other agents did. "Move back to Other Agents" archives
 * the thread, so the session is listed there again; continuing it unarchives
 * the thread. Fork add-on; see
 * docs/internals/external-sessions.md.
 *
 * @module external-sessions/handBack
 */
import {
  type ContextMenuItem,
  continuedThreadOriginInstanceId,
  type EnvironmentId,
  type ModelSelection,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ImportIcon } from "lucide-react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { getProviderInstanceEntry } from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { externalSessionHandBack, externalSessionRelease } from "./atoms";

interface ContinuedThread {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly modelSelection: ModelSelection;
}

export type HandBackMenuId = "hand-back" | "move-back";

export const isHandBackMenuId = (value: string | null): value is HandBackMenuId =>
  value === "hand-back" || value === "move-back";

/** The origin agent's name as this environment shows it, e.g. "Claude Code". */
const originName = (environmentId: EnvironmentId, threadId: ThreadId): string | null => {
  const origin = continuedThreadOriginInstanceId(threadId);
  if (origin === null) return null;
  const providers =
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.providers ?? [];
  return getProviderInstanceEntry(providers, origin)?.displayName ?? origin;
};

/**
 * Puts a continued thread's ways back first: "Hand back to <agent>" while the
 * thread is set to another agent, and always "Move back to Other Agents".
 */
export const withHandBackMenuItem = <T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  thread: ContinuedThread,
): ReadonlyArray<ContextMenuItem<T | HandBackMenuId>> => {
  const origin = continuedThreadOriginInstanceId(thread.id);
  if (origin === null) return items;
  const added: Array<ContextMenuItem<HandBackMenuId>> = [];
  if (thread.modelSelection.instanceId !== origin) {
    const name = originName(thread.environmentId, thread.id) ?? origin;
    added.push({ id: "hand-back", label: `Hand back to ${name}`, icon: "undo-2" });
  }
  added.push({ id: "move-back", label: "Move back to Other Agents", icon: "archive" });
  const [first, ...rest] = items;
  return first === undefined ? added : [...added, { ...first, separatorBefore: true }, ...rest];
};

export const handBackThread = async (
  threadRef: ScopedThreadRef,
  action: HandBackMenuId,
): Promise<void> => {
  const request = {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  };
  const result =
    action === "hand-back"
      ? await runAtomCommand(appAtomRegistry, externalSessionHandBack, request, {
          reportFailure: false,
        })
      : await runAtomCommand(appAtomRegistry, externalSessionRelease, request, {
          reportFailure: false,
        });
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: action === "hand-back" ? "Failed to hand back" : "Failed to move back",
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
};

/** The row's marker; the row's own tooltip names the origin. */
export function ContinuedThreadMarker(props: { readonly threadId: ThreadId }) {
  if (continuedThreadOriginInstanceId(props.threadId) === null) return null;
  return (
    <span className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70">
      <ImportIcon aria-hidden className="size-3" />
    </span>
  );
}

/** "Continued from <agent>" in the row's hover card. */
export function ContinuedFromLine(props: {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
}) {
  const name = originName(props.environmentId, props.threadId);
  if (name === null) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ImportIcon aria-hidden className="size-3 shrink-0 stroke-muted-foreground" />
      <div className="min-w-0 truncate text-foreground/75">Continued from {name}</div>
    </div>
  );
}
