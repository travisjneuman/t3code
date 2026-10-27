/**
 * Fork add-on: project links. Rows in Settings → Project → Checkouts that put
 * one project on several machines: link a folder project with one on another
 * machine, unlink a machine's copy, and add the project on a machine that
 * doesn't have it yet. Git projects already group by repository, so they only
 * get Add on (the clone or existing-checkout dialog); links are for folders
 * without a repository.
 */
import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { useAddProjectTargets } from "../../hooks/useAddProjectTargets";
import { newProjectId, randomUUID } from "../../lib/utils";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentsWithScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { openAddProjectToMachine } from "../AddProjectToMachineDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

type LinkMember = Pick<SidebarProjectGroupMember, "environmentId" | "id" | "linkKey">;

class CommandFailure extends Error {}

function throwOnFailure(result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure") return;
  if (isAtomCommandInterrupted(result)) throw new CommandFailure("");
  const error = squashAtomCommandFailure(result);
  throw new CommandFailure(error instanceof Error ? error.message : "An error occurred.");
}

function reportError(title: string, error: unknown) {
  if (error instanceof CommandFailure && error.message === "") return;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

const candidateLabel = (other: SidebarProjectSnapshot) =>
  `${other.displayName} · ${other.memberProjects
    .map((member) => member.environmentLabel ?? "machine")
    .join(", ")}`;

const isFolderProject = (group: Pick<SidebarProjectSnapshot, "memberProjects">) =>
  group.memberProjects.every((member) => member.repositoryIdentity == null && !member.isScratch);

/** Unlink beside a checkout's Remove. Unlinking the second-to-last copy clears the last one too. */
export function CheckoutUnlinkButton({
  group,
  member,
  canEdit,
}: {
  group: SidebarProjectSnapshot;
  member: SidebarProjectGroupMember;
  canEdit: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  if (!member.linkKey || !isFolderProject(group)) return null;
  const linked = group.memberProjects.filter((other) => other.linkKey === member.linkKey);
  const targets = linked.length <= 2 ? linked : [member];
  const unlink = async () => {
    if (busy) return;
    setBusy(true);
    try {
      for (const target of targets) {
        throwOnFailure(
          await updateProject({
            environmentId: target.environmentId,
            input: { projectId: target.id, linkKey: null },
          }),
        );
      }
    } catch (error) {
      reportError("Failed to unlink project", error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy || !canEdit}
      onClick={() => void unlink()}
      aria-label={`Unlink ${member.workspaceRoot}`}
    >
      Unlink
    </Button>
  );
}

/** One Checkouts section: the panel's checkout rows, then link and add rows. */
export function ProjectMachineLinks({
  group,
  canEdit,
  checkoutRows,
}: {
  group: SidebarProjectSnapshot;
  canEdit: boolean;
  checkoutRows: ReactNode;
}) {
  const { environments } = useEnvironments();
  const operable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const groups = useSettingsProjectGroups();
  const representative = group.memberProjects[0]!;
  const gitTargets = useAddProjectTargets(
    representative.repositoryIdentity == null ? null : representative,
    group.memberProjects,
  );
  const [busy, setBusy] = useState(false);
  const [paths, setPaths] = useState<Readonly<Record<string, string>>>({});
  const [candidateKey, setCandidateKey] = useState<string | null>(null);
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const createProject = useOrchestrationCommand(projectEnvironment.create, {
    reportFailure: false,
  });

  const setLinkKey = async (member: LinkMember, linkKey: string | null) => {
    if ((member.linkKey ?? null) === linkKey) return;
    throwOnFailure(
      await updateProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, linkKey },
      }),
    );
  };
  const linkMembers = async (members: ReadonlyArray<LinkMember>, linkKey: string) => {
    for (const member of members) await setLinkKey(member, linkKey);
  };

  const checkoutsOnly = checkoutRows ? (
    <SettingsSection title="Checkouts">{checkoutRows}</SettingsSection>
  ) : null;
  if (group.memberProjects.some((member) => member.isScratch)) return checkoutsOnly;
  const folderProject = isFolderProject(group);
  const linkKey = group.memberProjects.find((member) => member.linkKey)?.linkKey ?? null;
  const memberEnvironments = new Set(group.memberProjects.map((member) => member.environmentId));
  const missingEnvironments = environments
    .filter(
      (environment) =>
        !memberEnvironments.has(environment.environmentId) &&
        operable.has(environment.environmentId) &&
        canCreateProjectInEnvironment(environment.connection.phase),
    )
    .toSorted((a, b) => a.label.localeCompare(b.label));
  const candidates = folderProject
    ? groups.filter(
        (other) =>
          other.projectKey !== group.projectKey &&
          isFolderProject(other) &&
          other.memberProjects.every((member) => !memberEnvironments.has(member.environmentId)),
      )
    : [];
  const candidate = candidates.find((other) => other.projectKey === candidateKey) ?? null;

  const run = async (title: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      reportError(title, error);
    } finally {
      setBusy(false);
    }
  };

  const linkWith = (other: SidebarProjectSnapshot) =>
    run("Failed to link projects", async () => {
      const key =
        linkKey ?? other.memberProjects.find((member) => member.linkKey)?.linkKey ?? randomUUID();
      await linkMembers([...group.memberProjects, ...other.memberProjects], key);
      setCandidateKey(null);
    });

  const addFolderOn = (environmentId: EnvironmentId, label: string) =>
    run(`Failed to add on ${label}`, async () => {
      const workspaceRoot = paths[environmentId]?.trim() ?? "";
      if (workspaceRoot.length === 0) throw new Error(`Enter the folder on ${label}.`);
      const key = linkKey ?? randomUUID();
      await linkMembers(group.memberProjects, key);
      const projectId = newProjectId();
      throwOnFailure(
        await createProject({
          environmentId,
          input: {
            projectId,
            title: group.displayName,
            workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        }),
      );
      await setLinkKey({ environmentId, id: projectId, linkKey: null }, key);
      setPaths(({ [environmentId]: _added, ...rest }) => rest);
    });

  const showAddRows = folderProject ? missingEnvironments.length > 0 : gitTargets.length > 0;
  if (!showAddRows && candidates.length === 0) return checkoutsOnly;

  return (
    <SettingsSection title="Checkouts">
      {checkoutRows}
      {candidates.length > 0 ? (
        <SettingsRow
          title="Link with a project on another machine"
          description="Shows them as one project. Each machine keeps its own folder."
          control={
            <div className="flex items-center gap-2">
              <Select
                value={candidateKey ?? ""}
                onValueChange={(value) => setCandidateKey(value || null)}
              >
                <SelectTrigger size="sm" className="w-44" aria-label="Project to link">
                  <SelectValue placeholder="Choose a project">
                    {(key: string) => {
                      const other = candidates.find((option) => option.projectKey === key);
                      return other ? candidateLabel(other) : "Choose a project";
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {candidates.map((other) => (
                    <SelectItem key={other.projectKey} value={other.projectKey}>
                      {candidateLabel(other)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canEdit || candidate === null}
                onClick={() => candidate && void linkWith(candidate)}
              >
                Link
              </Button>
            </div>
          }
        />
      ) : null}
      {folderProject
        ? missingEnvironments.map((environment) => (
            <SettingsRow
              key={environment.environmentId}
              title={`Add on ${environment.label}`}
              description="The folder on that machine. It must already exist."
              control={
                <div className="flex items-center gap-2">
                  <Input
                    size="sm"
                    className="w-full sm:w-56"
                    aria-label={`Folder on ${environment.label}`}
                    placeholder="Folder path"
                    value={paths[environment.environmentId] ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setPaths((current) => ({ ...current, [environment.environmentId]: value }));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter")
                        void addFolderOn(environment.environmentId, environment.label);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !canEdit}
                    onClick={() => void addFolderOn(environment.environmentId, environment.label)}
                  >
                    Add
                  </Button>
                </div>
              }
            />
          ))
        : gitTargets.map((target) => (
            <SettingsRow
              key={target.environmentId}
              title={`Add on ${target.label}`}
              description="Finds an existing checkout there, or clones it."
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canEdit}
                  onClick={() =>
                    openAddProjectToMachine({
                      projectRef: scopeProjectRef(representative.environmentId, representative.id),
                      targetEnvironmentId: target.environmentId,
                    })
                  }
                >
                  Add…
                </Button>
              }
            />
          ))}
    </SettingsSection>
  );
}
