// Fork add-on: nested subagents. See packages/contracts/src/forkShellSubagents.ts.
import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { threadFamilies } from "../state/threads";

type OmittedGroups = NonNullable<OrchestrationV2ShellSnapshot["omittedSubagents"]>;

const NO_GROUPS: OmittedGroups = [];

/** Parent key to the keys of its idle subagents that the shell leaves out. */
type OmittedSubagentKeys = ReadonlyMap<string, ReadonlyArray<string>>;

// Deltas spread the snapshot, so the list keeps its reference until a snapshot or removal changes it.
const environmentOmittedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(threadFamilies.snapshotAtom(environmentId))?.omittedSubagents ?? NO_GROUPS,
  ).pipe(Atom.withLabel(`fork-omitted-subagents:${environmentId}`)),
);

const omittedSubagentKeysAtom = Atom.make((get): OmittedSubagentKeys => {
  const keys = new Map<string, ReadonlyArray<string>>();
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    for (const group of get(environmentOmittedAtom(environmentId))) {
      keys.set(
        scopedThreadKey(scopeThreadRef(environmentId, group.parentThreadId)),
        group.threadIds.map((threadId) => scopedThreadKey(scopeThreadRef(environmentId, threadId))),
      );
    }
  }
  return keys;
}).pipe(Atom.withLabel("fork-omitted-subagent-keys"));

export function useOmittedSubagentKeys(): OmittedSubagentKeys {
  return useAtomValue(omittedSubagentKeysAtom);
}

/** Omitted subagents under `parentKey` or one of its listed `rowKeys` that are not listed yet. */
export function omittedSubagentsUnder(
  omitted: OmittedSubagentKeys,
  parentKey: string,
  rowKeys: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (omitted.size === 0) return [];
  const listed = new Set(rowKeys);
  const missing = new Set<string>();
  for (const key of [parentKey, ...rowKeys]) {
    for (const childKey of omitted.get(key) ?? []) {
      if (!listed.has(childKey)) missing.add(childKey);
    }
  }
  return [...missing];
}

/**
 * Loads the families of the expanded top-level threads that have omitted subagents, so their rows
 * reach the sidebar. The caller checks the server's list, which a loaded family does not shrink.
 */
export function useOmittedSubagentFamilies(topLevelKeys: ReadonlyArray<string>): void {
  const mountKey = [...topLevelKeys].sort().join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts expanded parents' subagent families into the thread family registry while shown
  useEffect(() => {
    if (mountKey === "") return;
    const releases = mountKey.split("\n").flatMap((key) => {
      const ref = parseScopedThreadKey(key);
      return ref === null
        ? []
        : [threadFamilies.mount(appAtomRegistry, ref.environmentId, ref.threadId)];
    });
    return () => {
      for (const release of releases) release();
    };
  }, [mountKey]);
}
