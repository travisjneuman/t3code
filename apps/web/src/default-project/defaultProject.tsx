/**
 * The project new threads start in, chosen in Settings → Projects and kept on this device.
 * Without one, New thread starts without a project. Fork add-on: default project.
 */
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { SettingsRow } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";
import { getLocalStorageItem, useLocalStorage } from "../hooks/useLocalStorage";

const DEFAULT_PROJECT_STORAGE_KEY = "t3code:fork:default-project";
const DefaultProjectKey = Schema.NullOr(Schema.String);

interface ProjectGroup {
  readonly projectKey: string;
  readonly archived: boolean;
  readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
}

interface NewThreadContext {
  readonly activeThread?: { readonly environmentId: EnvironmentId } | null | undefined;
  readonly activeDraftThread?: { readonly environmentId: EnvironmentId } | null | undefined;
  readonly handleNewThread: (projectRef: ScopedProjectRef) => unknown;
}

/**
 * The chosen default project's checkout on `preferredEnvironmentId`, else its first one. Null
 * when no project is chosen, or the chosen one is archived or gone.
 */
function chosenDefaultProjectRef(
  groups: ReadonlyArray<ProjectGroup>,
  preferredEnvironmentId: EnvironmentId | null,
): ScopedProjectRef | null {
  const projectKey = getLocalStorageItem(DEFAULT_PROJECT_STORAGE_KEY, DefaultProjectKey);
  if (projectKey === null) return null;
  const group = groups.find((entry) => entry.projectKey === projectKey && !entry.archived);
  if (group === undefined) return null;
  return (
    group.memberProjectRefs.find((ref) => ref.environmentId === preferredEnvironmentId) ??
    group.memberProjectRefs[0] ??
    null
  );
}

/**
 * Starts a thread in the chosen default project, on the current thread's machine when the
 * project is there. False when Shift is held or no default applies, so the caller carries on.
 */
export function startInDefaultProject(
  groups: ReadonlyArray<ProjectGroup>,
  context: NewThreadContext,
  primaryEnvironmentId: EnvironmentId | null,
  event?: { readonly shiftKey?: boolean },
): boolean {
  if (event?.shiftKey === true) return false;
  const projectRef = chosenDefaultProjectRef(
    groups,
    context.activeThread?.environmentId ??
      context.activeDraftThread?.environmentId ??
      primaryEnvironmentId,
  );
  if (projectRef === null) return false;
  void context.handleNewThread(projectRef);
  return true;
}

/** The Settings → Projects row that makes a project the one new threads start in. */
export function DefaultProjectRow({ projectKey }: { projectKey: string }) {
  const [defaultProjectKey, setDefaultProjectKey] = useLocalStorage(
    DEFAULT_PROJECT_STORAGE_KEY,
    null,
    DefaultProjectKey,
  );
  return (
    <SettingsRow
      title="Start new threads here"
      description="New thread and its shortcut start in this project on this device. Shift-click still picks the current project. Off starts without a project."
      control={
        <Switch
          checked={defaultProjectKey === projectKey}
          onCheckedChange={(checked) => setDefaultProjectKey(checked ? projectKey : null)}
          aria-label="Start new threads here"
        />
      }
    />
  );
}
