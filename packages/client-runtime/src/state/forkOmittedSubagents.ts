// Fork add-on: nested subagents. See packages/contracts/src/forkShellSubagents.ts.
import type {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  ThreadId,
} from "@t3tools/contracts";

/** Drops a thread that left the active shell from the snapshot's omitted-subagent list. */
export function withoutOmittedSubagent(
  snapshot: OrchestrationV2ShellSnapshot,
  threadId: ThreadId,
): Pick<OrchestrationV2ShellSnapshot, "omittedSubagents"> {
  const groups = snapshot.omittedSubagents;
  if (groups === undefined) return {};
  const next = groups.flatMap((group) => {
    if (group.parentThreadId === threadId) return [];
    if (!group.threadIds.includes(threadId)) return [group];
    const threadIds = group.threadIds.filter((id) => id !== threadId);
    return threadIds.length === 0 ? [] : [{ ...group, threadIds }];
  });
  return next.length === groups.length && next.every((group, index) => group === groups[index])
    ? { omittedSubagents: groups }
    : { omittedSubagents: next };
}

/** A thread that moves out of the active shell (an older server's archive delta) leaves the list. */
export function omittedSubagentsAfterUpdate(
  snapshot: OrchestrationV2ShellSnapshot,
  event: Extract<OrchestrationV2ShellStreamItem, { readonly kind: "thread.updated" }>,
): Pick<OrchestrationV2ShellSnapshot, "omittedSubagents"> {
  return event.location === "active" ? {} : withoutOmittedSubagent(snapshot, event.thread.id);
}
