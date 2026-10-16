import type {
  EditorId,
  EnvironmentId,
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
import { ThreadSessionDetails } from "./ThreadSessionInsightsSection"; // Fork add-on: session details.

const GitActionsControl = memo(BaseGitActionsControl);

export interface ThreadDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle" | "onPresentationChange"
> {
  forceNewWorktree?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  gitCwd: string | null;
  isGitRepo: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange: (environmentId: EnvironmentId) => void;
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
  // Fork add-on: session details.
  contextWindow?: ContextWindowSnapshot | null;
  /** Present when the provider can compact on request; the button follows the composer's. */
  onCompactContext?: () => void;
  compactDisabled?: boolean;
  compactDisabledReason?: string | null;
  onOpenTurnDiff?: (runId: RunId, filePath?: string) => void;
  /**
   * Set for a Hermes thread: the machine Hermes works on. Hermes never uses
   * the project's folder, so the workspace and version control controls give
   * way to that machine's name. Fork add-on: Hermes provider.
   */
  hermesMachine?: string;
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
      onPresentationChange={props.onPresentationChange}
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
              {/* Fork add-on: Hermes provider. */}
              {props.hermesMachine !== undefined ? (
                <p className="px-1.5 py-1 text-muted-foreground text-sm">
                  Runs on {props.hermesMachine}, in Hermes's own workspace
                </p>
              ) : null}
              {density === "full" && localWorkspace ? (
                <BranchToolbar
                  layout="panel"
                  panelSection="workspace"
                  availableEnvironments={props.availableEnvironments}
                  onEnvironmentChange={props.onEnvironmentChange}
                  autoEnvironmentLabel={props.autoEnvironmentLabel}
                  onAutoEnvironment={props.onAutoEnvironment}
                  {...branchToolbarProps}
                />
              ) : null}

              {density !== "essential" && props.showOpenInPicker && localWorkspace ? (
                <OpenInPicker
                  keybindings={props.keybindings}
                  environmentId={props.environmentId}
                  availableEditors={props.availableEditors}
                  openInCwd={props.gitCwd}
                  displayMode="panel"
                />
              ) : null}

              {props.activeProjectScripts && localWorkspace ? (
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

          {props.gitCwd && localWorkspace ? (
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
                    displayMode="panel"
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
            <ThreadAutomationsPanel environmentId={props.environmentId} threadId={props.threadId} />
          ) : null}

          {/* Fork add-on: session details. */}
          {density === "full" && !props.draftId ? (
            <ThreadSessionDetails
              environmentId={props.environmentId}
              threadId={props.threadId}
              workspaceRoot={props.gitCwd ?? undefined}
              contextWindow={props.contextWindow ?? null}
              onCompactContext={props.onCompactContext}
              compactDisabled={props.compactDisabled ?? true}
              compactDisabledReason={props.compactDisabledReason ?? null}
              onOpenTurnDiff={props.onOpenTurnDiff}
            />
          ) : null}

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
