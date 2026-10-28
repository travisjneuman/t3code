import type {
  EditorId,
  EnvironmentId,
  ProjectId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  RunId, // Fork add-on: session details.
  ThreadId,
} from "@t3tools/contracts";

import type { DraftId } from "../../composerDraftStore";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import type { ContextWindowSnapshot } from "../../lib/contextWindow"; // Fork add-on: session details.
import { type EnvMode, type EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import BaseGitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { memo, type ComponentProps } from "react";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { ThreadServersPanel } from "./ThreadServersPanel";
import { ThreadSessionDetails } from "./ThreadSessionInsightsSection"; // Fork add-on: session details.

const GitActionsControl = memo(BaseGitActionsControl);

interface ThreadDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle"
> {
  forceNewWorktree?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  isServerThread: boolean;
  draftId?: DraftId;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  openInShortcutEnabled: boolean;
  gitCwd: string | null;
  isGitRepo: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  contextWindow?: ContextWindowSnapshot | null; // Fork add-on
  /** Fork add-on: Present when the provider can compact on request; the button follows the composer's. */
  onCompactContext?: () => void; // Fork add-on
  compactDisabled?: boolean; // Fork add-on
  compactDisabledReason?: string | null; // Fork add-on
  onOpenTurnDiff?: (runId: RunId, filePath?: string) => void; // Fork add-on
  /** Fork add-on: Hermes provider.
   * Set for a Hermes thread: the machine Hermes works on. Hermes never uses
   * the project's folder, so the workspace and version control controls give
   * way to that machine's name.
   */
  hermesMachine?: string; // Fork add-on
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const localWorkspace = props.hermesMachine === undefined; // Fork add-on: Hermes provider.
  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts ? props.gitCwd : null,
  );
  const activeThreadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const branchToolbarProps = {
    showGitControls: props.isGitRepo,
    environmentId: props.environmentId,
    threadId: props.threadId,
    projectId: props.projectId,
    worktreePath: props.worktreePath,
    isServerThread: props.isServerThread,
    ...(props.draftId ? { draftId: props.draftId } : {}),
    onEnvModeChange: props.onEnvModeChange,
    startFromOrigin: props.startFromOrigin,
    onStartFromOriginChange: props.onStartFromOriginChange,
    envMode: props.envMode,
    ...(props.activeThreadBranchOverride !== undefined
      ? { activeThreadBranchOverride: props.activeThreadBranchOverride }
      : {}),
    ...(props.onActiveThreadBranchOverrideChange
      ? { onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange }
      : {}),
    envLocked: props.envLocked,
    forceNewWorktree: props.forceNewWorktree ?? false,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  return (
    <ThreadDetailsCard
      threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
      anchor={props.anchor}
      handle={props.handle}
    >
      {(density) => (
        <>
          <ThreadDetailsSection
            headingId="thread-details-workspace-heading"
            title="Workspace"
            separated={false}
            showHeading={false}
          >
            <div className="flex flex-col">
              {props.hermesMachine !== undefined ? ( // Fork add-on
                <p className="px-1.5 py-1 text-muted-foreground text-sm" /* Fork add-on */>
                  Runs on {props.hermesMachine /* Fork add-on */}, in Hermes's own workspace
                </p> // Fork add-on
              ) : /* Fork add-on */ null}
              {density === "full" && localWorkspace ? ( // Fork add-on
                <BranchToolbar
                  layout="panel"
                  panelSection="workspace"
                  availableEnvironments={props.availableEnvironments}
                  {...(props.onEnvironmentChange
                    ? { onEnvironmentChange: props.onEnvironmentChange }
                    : {})}
                  autoEnvironmentLabel={props.autoEnvironmentLabel}
                  onAutoEnvironment={props.onAutoEnvironment}
                  {...branchToolbarProps}
                />
              ) : null}

              {density !== "essential" && props.showOpenInPicker && localWorkspace ? ( // Fork add-on
                <OpenInPicker
                  keybindings={props.keybindings}
                  environmentId={props.environmentId}
                  availableEditors={props.availableEditors}
                  openInCwd={props.gitCwd}
                  enableShortcut={props.openInShortcutEnabled}
                  displayMode="panel"
                />
              ) : null}

              {props.activeProjectScripts && localWorkspace ? ( // Fork add-on
                <ProjectScriptsControl
                  environmentId={props.environmentId}
                  displayMode="panel"
                  scripts={props.activeProjectScripts}
                  fileScripts={fileScripts}
                  preferredScriptId={props.preferredScriptId}
                  onRunScript={props.onRunProjectScript}
                  onAddScript={props.onAddProjectScript}
                  onUpdateScript={props.onUpdateProjectScript}
                  onDeleteScript={props.onDeleteProjectScript}
                />
              ) : null}
            </div>
          </ThreadDetailsSection>

          {props.gitCwd && localWorkspace ? ( // Fork add-on
            <ThreadDetailsSection
              headingId="thread-details-version-control-heading"
              title="Version Control"
              showHeading={false}
              separated={density === "full"}
            >
              <div className="flex flex-col">
                {props.isGitRepo ? (
                  <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
                ) : null}
                {props.activeProjectName ? (
                  <GitActionsControl
                    compact={density !== "full"}
                    gitCwd={props.gitCwd}
                    activeThreadRef={activeThreadRef}
                    {...(props.draftId ? { draftId: props.draftId } : {})}
                    {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                  />
                ) : null}
              </div>
            </ThreadDetailsSection>
          ) : null}

          {density === "full" && !props.draftId ? (
            <ThreadServersPanel environmentId={props.environmentId} threadId={props.threadId} />
          ) : null}

          {density === "full" && !props.draftId ? (
            <ThreadAutomationsPanel environmentId={props.environmentId} threadId={props.threadId} />
          ) : null}

          {density === "full" && !props.draftId ? ( // Fork add-on
            <ThreadSessionDetails // Fork add-on
              environmentId={props.environmentId} // Fork add-on
              threadId={props.threadId} // Fork add-on
              workspaceRoot={props.gitCwd ?? undefined} // Fork add-on
              contextWindow={props.contextWindow ?? null} // Fork add-on
              onCompactContext={props.onCompactContext} // Fork add-on
              compactDisabled={props.compactDisabled ?? true} // Fork add-on
              compactDisabledReason={props.compactDisabledReason ?? null} // Fork add-on
              onOpenTurnDiff={props.onOpenTurnDiff} // Fork add-on
            /> // Fork add-on
          ) : /* Fork add-on */ null}

          {density === "full" && !props.draftId ? (
            <ThreadRelationshipsPanel
              environmentId={props.environmentId}
              threadId={props.threadId}
            />
          ) : null}
        </>
      )}
    </ThreadDetailsCard>
  );
}
