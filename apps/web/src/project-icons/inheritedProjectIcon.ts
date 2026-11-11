/**
 * A checkout with no icon of its own shows the icon chosen on another machine's checkout of the
 * same project. An image is read from this checkout by the same path. Fork add-on: project icons.
 */
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

import { getClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { useProjects } from "../state/entities";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";

type IconChoice = Pick<EnvironmentProject, "faviconPath" | "projectIcon">;
type IconProject = IconChoice & Pick<EnvironmentProject, "environmentId" | "workspaceRoot">;

const checkoutKey = (environmentId: EnvironmentId, workspaceRoot: string) =>
  `${environmentId}\u0000${workspaceRoot}`;

const hasIcon = (project: IconChoice) =>
  (project.faviconPath ?? null) !== null || (project.projectIcon ?? null) !== null;

// One pass per projects list; every icon on screen reads the same map.
const inheritedByProjects = new WeakMap<
  ReadonlyArray<EnvironmentProject>,
  ReadonlyMap<string, IconChoice>
>();

function inheritedIcons(projects: ReadonlyArray<EnvironmentProject>) {
  const cached = inheritedByProjects.get(projects);
  if (cached !== undefined) return cached;
  const inherited = new Map<string, IconChoice>();
  const groups = buildSidebarProjectSnapshots({
    projects,
    groupScratchProjects: true,
    settings: selectProjectGroupingSettings(getClientSettings()),
    primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
    resolveEnvironmentLabel: () => null,
  });
  for (const group of groups) {
    const chosen = group.memberProjects.filter(hasIcon);
    const choices = new Set(
      chosen.map((member) => JSON.stringify([member.faviconPath, member.projectIcon])),
    );
    // Checkouts that disagree keep their own icons.
    const source = choices.size === 1 ? chosen[0] : undefined;
    if (source === undefined) continue;
    for (const member of group.memberProjects) {
      if (hasIcon(member)) continue;
      inherited.set(checkoutKey(member.environmentId, member.workspaceRoot), {
        faviconPath: source.faviconPath,
        projectIcon: source.projectIcon,
      });
    }
  }
  inheritedByProjects.set(projects, inherited);
  return inherited;
}

/** `project`, with its project's icon from another machine when it has none of its own. */
export function useProjectWithInheritedIcon<T extends IconProject>(project: T): T {
  const projects = useProjects();
  if (hasIcon(project)) return project;
  const inherited = inheritedIcons(projects).get(
    checkoutKey(project.environmentId, project.workspaceRoot),
  );
  return inherited === undefined ? project : { ...project, ...inherited };
}
