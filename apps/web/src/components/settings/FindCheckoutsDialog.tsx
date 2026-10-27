/**
 * Fork add-on: find checkouts. Searches each connected machine for checkouts of
 * the git projects it doesn't have yet, then adds the ones you pick in place.
 * It never clones; a project no machine has gets an Add on… shortcut instead.
 * Each search reads that machine's disk, so it only runs when you press Search.
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  repositoryGroupingKeyOf,
} from "@t3tools/contracts";
import { FolderSearchIcon } from "lucide-react";
import { useRef, useState } from "react";
import { create } from "zustand";

import { addExistingCheckout } from "../../lib/addProjectToMachine";
import { newProjectId } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  existingCheckoutQuery,
  joinSubdirectory,
  openAddProjectToMachine,
  projectSubdirectory,
} from "../AddProjectToMachineDialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { MiddleTruncate } from "../ui/middle-truncate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

const SEARCHES_PER_MACHINE = 2;

const useFindCheckouts = create<{ open: boolean }>(() => ({ open: false }));

export function openFindCheckouts() {
  useFindCheckouts.setState({ open: true });
}

const close = () => useFindCheckouts.setState({ open: false });

export function FindCheckoutsButton() {
  return (
    <SettingsPageContainer>
      <Button variant="outline" size="xs" className="self-start" onClick={openFindCheckouts}>
        <FolderSearchIcon />
        Find projects on other machines
      </Button>
    </SettingsPageContainer>
  );
}

export function FindCheckoutsDialogHost() {
  const open = useFindCheckouts((state) => state.open);
  return open ? <FindCheckoutsDialog /> : null;
}

interface Search {
  readonly key: string;
  readonly group: SidebarProjectSnapshot;
  readonly environmentId: EnvironmentId;
  readonly machine: string;
  readonly repositoryKey: string;
  readonly subdirectory: string;
}

type Outcome =
  | { readonly status: "searching" }
  | { readonly status: "found"; readonly workspaceRoot: string }
  | { readonly status: "missing" }
  | { readonly status: "failed" };

function useSearches(): readonly Search[] {
  const groups = useSettingsProjectGroups();
  const { environments } = useEnvironments();
  const operable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const machines = environments.filter(
    (environment) =>
      operable.has(environment.environmentId) &&
      canCreateProjectInEnvironment(environment.connection.phase) &&
      environment.serverConfig?.environment.capabilities.existingCheckout === true,
  );
  return groups.flatMap((group) => {
    const source = group.memberProjects.find((member) => member.repositoryIdentity != null);
    if (!source?.repositoryIdentity || source.isScratch) return [];
    const repositoryKey = repositoryGroupingKeyOf(source.repositoryIdentity);
    const subdirectory = projectSubdirectory(
      source.repositoryIdentity.rootPath,
      source.workspaceRoot,
    );
    const present = new Set(group.memberProjects.map((member) => member.environmentId));
    return machines
      .filter((machine) => !present.has(machine.environmentId))
      .map((machine) => ({
        key: `${group.projectKey}\n${machine.environmentId}`,
        group,
        environmentId: machine.environmentId,
        machine: machine.label,
        repositoryKey,
        subdirectory,
      }));
  });
}

async function findCheckout(search: Search): Promise<Outcome> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    existingCheckoutQuery({
      environmentId: search.environmentId,
      input: { repositoryKey: search.repositoryKey },
    }),
    { label: "Find existing checkout", reportFailure: false, refresh: true },
  );
  if (result._tag === "Failure") return { status: "failed" };
  const root = result.value.repositoryRoot;
  return root === null
    ? { status: "missing" }
    : { status: "found", workspaceRoot: joinSubdirectory(root, search.subdirectory) };
}

function FindCheckoutsDialog() {
  const searches = useSearches();
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Outcome> | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const runRef = useRef(0);

  const searching =
    outcomes !== null && [...outcomes.values()].some((o) => o.status === "searching");
  const searched = outcomes === null ? [] : searches.filter((search) => outcomes.has(search.key));
  const found = searched.filter((search) => outcomes?.get(search.key)?.status === "found");
  const missing = searched.filter((search) => outcomes?.get(search.key)?.status !== "found");

  const startSearch = () => {
    const run = ++runRef.current;
    setSelected(new Set());
    setOutcomes(new Map<string, Outcome>(searches.map((s) => [s.key, { status: "searching" }])));
    const settle = (search: Search, outcome: Outcome) => {
      if (runRef.current !== run) return;
      setOutcomes((current) => new Map(current).set(search.key, outcome));
      if (outcome.status === "found") setSelected((current) => new Set(current).add(search.key));
    };
    const byMachine = new Map<EnvironmentId, Search[]>();
    for (const search of searches) {
      byMachine.set(search.environmentId, [...(byMachine.get(search.environmentId) ?? []), search]);
    }
    for (const pending of byMachine.values()) {
      const worker = async () => {
        for (let search = pending.shift(); search; search = pending.shift()) {
          if (runRef.current !== run) return;
          settle(search, await findCheckout(search).catch((): Outcome => ({ status: "failed" })));
        }
      };
      for (let i = 0; i < SEARCHES_PER_MACHINE; i += 1) void worker();
    }
  };

  const addSelected = async () => {
    if (adding) return;
    setAdding(true);
    let added = 0;
    for (const search of found.filter((candidate) => selected.has(candidate.key))) {
      const outcome = outcomes?.get(search.key);
      if (outcome?.status !== "found") continue;
      try {
        await addExistingCheckout({
          environmentId: search.environmentId,
          projectId: newProjectId(),
          title: search.group.displayName,
          workspaceRoot: outcome.workspaceRoot,
        });
        added += 1;
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to add ${search.group.displayName} on ${search.machine}`,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    }
    setAdding(false);
    if (added > 0) {
      toastManager.add({
        type: "success",
        title: added === 1 ? "Added 1 checkout" : `Added ${added} checkouts`,
      });
      close();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          runRef.current += 1;
          close();
        }
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Find projects on other machines</DialogTitle>
          <DialogDescription>
            Looks for checkouts of your git projects on each connected machine that doesn't have
            them yet: in its add-project folder and next to its other projects. Nothing is cloned.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {outcomes === null ? (
            <p className="text-muted-foreground text-sm">
              {searches.length === 0
                ? "Every connected machine already has every git project, or none can be searched."
                : `${searches.length} ${searches.length === 1 ? "search" : "searches"} across your machines.`}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {searching ? <p className="text-muted-foreground text-sm">Searching…</p> : null}
              {found.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <span className="font-medium text-sm">Found</span>
                  {found.map((search) => {
                    const outcome = outcomes.get(search.key);
                    return (
                      <label key={search.key} className="flex min-w-0 items-center gap-2 text-sm">
                        <Checkbox
                          checked={selected.has(search.key)}
                          onCheckedChange={(checked) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (checked) next.add(search.key);
                              else next.delete(search.key);
                              return next;
                            })
                          }
                        />
                        <span className="shrink-0">{`${search.group.displayName} on ${search.machine}`}</span>
                        <MiddleTruncate
                          className="min-w-0 flex-1 font-mono text-muted-foreground text-xs"
                          value={outcome?.status === "found" ? outcome.workspaceRoot : ""}
                        />
                      </label>
                    );
                  })}
                </div>
              ) : null}
              {!searching && missing.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <span className="font-medium text-sm">Not found</span>
                  {missing.map((search) => (
                    <div key={search.key} className="flex min-w-0 items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">
                        {`${search.group.displayName} on ${search.machine}`}
                        {outcomes.get(search.key)?.status === "failed" ? " (search failed)" : ""}
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          const source = search.group.memberProjects.find(
                            (member) => member.repositoryIdentity != null,
                          );
                          if (!source) return;
                          close();
                          openAddProjectToMachine({
                            projectRef: scopeProjectRef(source.environmentId, source.id),
                            targetEnvironmentId: search.environmentId,
                          });
                        }}
                      >
                        Add on…
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
              {!searching && found.length === 0 && missing.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing to search.</p>
              ) : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            Close
          </Button>
          {outcomes === null || searching ? (
            <Button
              type="button"
              disabled={searching || searches.length === 0}
              onClick={startSearch}
            >
              {searching ? "Searching…" : "Search"}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={adding || selected.size === 0}
              onClick={() => void addSelected()}
            >
              {selected.size > 1 ? `Add ${selected.size} selected` : "Add selected"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
