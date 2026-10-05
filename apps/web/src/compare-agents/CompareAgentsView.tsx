/**
 * Compare agents page. Without a pair it is the setup form, one prompt and
 * two models, in No project by default, above the earlier and archived
 * comparisons. With a pair it shows both threads side by side, each as a
 * standard thread timeline, over CompareComposer, the message box that
 * drives both. The header and list rows open the comparison's menu.
 * Fork add-on: compare agents; see docs/user/compare-agents.md.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  COMPARE_REVIEW_MESSAGE_PREFIX,
  compareThreadIds,
  type EnvironmentId,
  type ModelSelection,
  threadExchanges,
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, EllipsisIcon, PlusIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import { scheduledTaskDefaultModel } from "../components/settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../components/settings/settingsLayout";
import { isTrailingDoubleClick } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../components/WorkspaceBreadcrumb";
import { isElectron } from "../env";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import type { ProviderInstanceEntry } from "../providerInstances";
import {
  useProjects,
  useThreadProjection,
  useThreadShell,
  useThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { startComparison } from "./compareAgents";
import { CompareComposer, useCompareProviders } from "./CompareComposer";
import { type ComparePair, comparePromptOf, groupComparePairs } from "./comparePairs";
import { startCompareRename, stopCompareRename, useCompareRenameStore } from "./compareRenameStore";
import { CompareThreadColumn } from "./CompareThreadColumn";
import { useComparePairMenu, useRenameComparison } from "./useComparePairMenu";

const isSendShortcut = (event: KeyboardEvent) =>
  event.key === "Enter" && (event.metaKey || event.ctrlKey);

/** The setup form's project choice for the environment's Scratch project. */
const NO_PROJECT = "no-project";

export function CompareAgentsView(props: {
  environmentId: EnvironmentId;
  pairId: string | undefined;
  fromThreadId: string | undefined;
}) {
  const { environmentId, pairId } = props;
  const navigate = useNavigate();
  const goToStart = useCallback(
    () => void navigate({ to: "/compare/$environmentId", params: { environmentId }, search: {} }),
    [environmentId, navigate],
  );
  // The comparison being renamed, in the header or its list row. It belongs
  // to the page it started on; leaving that page drops it, like ChatHeader's rename.
  const renamingPairId = useCompareRenameStore((state) =>
    state.onPage === pairId ? state.pairId : null,
  );
  useEffect(
    () => () => {
      if (useCompareRenameStore.getState().onPage === pairId) stopCompareRename();
    },
    [pairId],
  );
  const startRename = useCallback(
    (renamedPairId: string) => startCompareRename(renamedPairId, pairId),
    [pairId],
  );
  const renameComparison = useRenameComparison(environmentId);
  const finishRename = useCallback(
    (renamedPairId: string, name: string | null) => {
      stopCompareRename();
      if (name !== null) renameComparison(renamedPairId, name);
    },
    [renameComparison],
  );
  const leaveIfOpen = useCallback(
    (removedPairId: string) => {
      if (removedPairId === pairId) goToStart();
    },
    [goToStart, pairId],
  );
  const { openMenu, openArchivedMenu } = useComparePairMenu({
    environmentId,
    onStartRename: startRename,
    onRemoved: leaveIfOpen,
  });
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      <header
        className={cn(
          "relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 bg-background",
          isElectron
            ? "drag-region px-3 sm:px-5 wco:pr-(--workspace-native-controls-inset)"
            : "pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        onContextMenu={(event) => {
          if (pairId === undefined || renamingPairId === pairId) return;
          event.preventDefault();
          openMenu(pairId, { x: event.clientX, y: event.clientY });
        }}
      >
        {pairId !== undefined ? (
          <>
            <ComparePairTitle
              environmentId={environmentId}
              pairId={pairId}
              renaming={renamingPairId === pairId}
              onOpenMenu={openMenu}
              onStartRename={startRename}
              onFinishRename={finishRename}
            />
            <Button size="sm" variant="ghost" onClick={goToStart}>
              <PlusIcon />
              New comparison
            </Button>
          </>
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">Compare agents</h2>
        )}
      </header>
      {pairId !== undefined ? (
        <CompareResults environmentId={environmentId} pairId={pairId} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6">
          {props.fromThreadId !== undefined ? (
            <CompareSetupFromThread environmentId={environmentId} threadId={props.fromThreadId} />
          ) : (
            <CompareSetup
              environmentId={environmentId}
              initialProjectId={undefined}
              initialPrompt=""
              initialLeft={null}
            />
          )}
          <EarlierComparisons
            environmentId={environmentId}
            renamingPairId={renamingPairId}
            onOpenMenu={openMenu}
            onFinishRename={finishRename}
          />
          <ArchivedComparisons environmentId={environmentId} onOpenMenu={openArchivedMenu} />
        </div>
      )}
    </SidebarInset>
  );
}

type OpenPairMenu = (pairId: string, position: { x: number; y: number }) => void;
type FinishRename = (pairId: string, name: string | null) => void;

const belowElement = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
};

/** ChatHeader's wait before a title click opens the menu, so a double-click can rename. */
const TITLE_MENU_OPEN_DELAY_MS = 500;

/**
 * The thread header's breadcrumb for a comparison: Compare agents / its name.
 * The name opens the comparison's menu and double-clicking it renames, like a
 * thread title.
 */
function ComparePairTitle(props: {
  environmentId: EnvironmentId;
  pairId: string;
  renaming: boolean;
  onOpenMenu: OpenPairMenu;
  onStartRename: (pairId: string) => void;
  onFinishRename: FinishRename;
}) {
  const { environmentId, pairId, onOpenMenu, onStartRename } = props;
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuTimerRef = useRef<number | null>(null);
  const cancelPendingMenu = useCallback(() => {
    if (menuTimerRef.current === null) return;
    clearTimeout(menuTimerRef.current);
    menuTimerRef.current = null;
  }, []);
  useEffect(() => cancelPendingMenu, [cancelPendingMenu, pairId]);
  const openMenuNow = useCallback(() => {
    cancelPendingMenu();
    if (titleButtonRef.current !== null) onOpenMenu(pairId, belowElement(titleButtonRef.current));
  }, [cancelPendingMenu, onOpenMenu, pairId]);
  const openMenuFromTitle = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (isTrailingDoubleClick(event.detail)) return;
      // Keyboard, the chevron and the web menu (which a dblclick can close)
      // open at once; the native menu waits so it can't swallow a second click.
      const clickedChevron =
        (event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null;
      if (event.detail === 0 || clickedChevron || window.desktopBridge === undefined) {
        openMenuNow();
        return;
      }
      cancelPendingMenu();
      menuTimerRef.current = window.setTimeout(openMenuNow, TITLE_MENU_OPEN_DELAY_MS);
    },
    [cancelPendingMenu, openMenuNow],
  );
  const renameFromTitle = useCallback(
    (event: ReactMouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
      cancelPendingMenu();
      void readLocalApi()?.contextMenu.close();
      onStartRename(pairId);
    },
    [cancelPendingMenu, onStartRename, pairId],
  );
  const [leftId, rightId] = compareThreadIds(pairId);
  const left = useThreadShell(scopeThreadRef(environmentId, leftId));
  const right = useThreadShell(scopeThreadRef(environmentId, rightId));
  const title = comparePromptOf((left ?? right)?.title ?? "Comparison");
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <WorkspaceBreadcrumb
        ariaLabel="Comparison breadcrumb"
        className="flex-1 overflow-clip [overflow-clip-margin:2px]"
      >
        <WorkspaceBreadcrumbItem className="shrink">
          <WorkspaceBreadcrumbText className="text-muted-foreground">
            Compare agents
          </WorkspaceBreadcrumbText>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator>
          <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
        </WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
          {props.renaming ? (
            <CompareRenameInput
              initial={title}
              onFinish={(name) => props.onFinishRename(pairId, name)}
            />
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    ref={titleButtonRef}
                    type="button"
                    aria-label={`Comparison actions for ${title}`}
                    aria-haspopup="menu"
                    onClick={openMenuFromTitle}
                    onDoubleClick={renameFromTitle}
                    onBlur={cancelPendingMenu}
                    className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <h2 className="min-w-0">
                  <WorkspaceBreadcrumbText>{title}</WorkspaceBreadcrumbText>
                </h2>
                <ChevronDownIcon
                  aria-hidden
                  data-thread-title-chevron
                  className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{title}</TooltipPopup>
            </Tooltip>
          )}
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
    </div>
  );
}

/** ChatHeader's inline rename: Enter or leaving the field saves, Escape cancels. */
function CompareRenameInput(props: { initial: string; onFinish: (name: string | null) => void }) {
  const finishedRef = useRef(false);
  const finish = (name: string | null) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    props.onFinish(name);
  };
  return (
    <input
      autoFocus
      aria-label="Comparison name"
      className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-ring/50 focus:ring-ring"
      defaultValue={props.initial}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") finish(event.currentTarget.value);
        else if (event.key === "Escape") finish(null);
      }}
    />
  );
}

function Field(props: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      {props.children}
    </div>
  );
}

/**
 * Default model on another provider than `avoid`'s, else on another instance,
 * so the two sides differ by default.
 */
function otherDefaultModel(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  avoid: ModelSelection | null,
): ModelSelection | null {
  const usable = entries.filter(
    (candidate) =>
      candidate.enabled &&
      candidate.installed &&
      candidate.isAvailable &&
      candidate.snapshot.auth.status !== "unauthenticated" &&
      candidate.instanceId !== avoid?.instanceId,
  );
  const avoidDriver = entries.find(
    (candidate) => candidate.instanceId === avoid?.instanceId,
  )?.driverKind;
  const entry = usable.find((candidate) => candidate.driverKind !== avoidDriver) ?? usable[0];
  const models = entry?.models.filter((model) => !model.isLegacy) ?? [];
  const model = models.find((candidate) => candidate.isDefault) ?? models[0];
  return entry && model ? createModelSelection(entry.instanceId, model.slug) : avoid;
}

/** The setup form prefilled from a thread: its project (or No project), model, and latest prompt. */
function CompareSetupFromThread(props: { environmentId: EnvironmentId; threadId: string }) {
  const thread = useThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId as ThreadId),
  );
  const projection = thread?.projection ?? null;
  if (projection === null) {
    return <p className="pt-6 text-sm text-muted-foreground">Loading the thread…</p>;
  }
  const prompt = threadExchanges(projection).findLast((exchange) => exchange.prompt !== null)
    ?.prompt?.text;
  return (
    <CompareSetup
      environmentId={props.environmentId}
      initialProjectId={projection.thread.projectId}
      initialPrompt={prompt ?? ""}
      initialLeft={projection.thread.modelSelection}
    />
  );
}

function CompareSetup(props: {
  environmentId: EnvironmentId;
  initialProjectId: string | undefined;
  initialPrompt: string;
  initialLeft: ModelSelection | null;
}) {
  const { environmentId } = props;
  const navigate = useNavigate();
  const allProjects = useProjects();
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  // Null when this environment offers no Scratch folder ("No project").
  const scratchRoot = availableScratchWorkspaceRoot(
    environment?.connection.phase,
    environment?.serverConfig,
  );
  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) =>
          project.environmentId === environmentId && !isScratchProject(project, scratchRoot),
      ),
    [allProjects, environmentId, scratchRoot],
  );
  const { settings, entries } = useCompareProviders(environmentId);
  const [projectId, setProjectId] = useState(props.initialProjectId ?? NO_PROJECT);
  const [prompt, setPrompt] = useState(props.initialPrompt);
  const [leftChoice, setLeftChoice] = useState<ModelSelection | null>(props.initialLeft);
  const [rightChoice, setRightChoice] = useState<ModelSelection | null>(null);
  const [starting, setStarting] = useState(false);

  // Anything but a listed project (No project, the Scratch project itself) means No project.
  const project =
    projects.find((candidate) => candidate.id === projectId) ??
    (scratchRoot === null ? (projects[0] ?? null) : null);
  const leftDefault = scheduledTaskDefaultModel(settings, project, entries);
  const left = leftChoice ?? leftDefault;
  const right = rightChoice ?? otherDefaultModel(entries, left);
  const hasPlace = project !== null || scratchRoot !== null;
  const canStart = !starting && hasPlace && prompt.trim() !== "" && !!left && !!right;

  const start = async () => {
    if (!canStart || !left || !right) return;
    setStarting(true);
    const pairId = await startComparison(environmentId, {
      ...(project === null ? {} : { projectId: project.id }),
      prompt: prompt.trim(),
      left,
      right,
    });
    setStarting(false);
    if (pairId !== null) {
      await navigate({
        to: "/compare/$environmentId",
        params: { environmentId },
        search: { pair: pairId },
      });
    }
  };

  if (!hasPlace) {
    return <p className="pt-6 text-sm text-muted-foreground">Add a project first.</p>;
  }
  return (
    <div className="mx-auto max-w-2xl space-y-5 pt-4">
      <p className="text-sm text-muted-foreground">
        Send one prompt to two agents and see their answers side by side. Each side becomes its own
        thread.{" "}
        {project === null
          ? "With No project, each agent gets an empty folder of its own, so both can build freely."
          : "Both work in the project folder itself, so prefer questions and reviews over edits."}
      </p>
      <Field label="Project">
        <Select value={project?.id ?? NO_PROJECT} onValueChange={(id) => setProjectId(String(id))}>
          <SelectTrigger size="sm">
            <SelectValue>{project?.title ?? "No project"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {scratchRoot !== null ? (
              <SelectItem value={NO_PROJECT}>
                No project · a separate folder for each side
              </SelectItem>
            ) : null}
            {projects.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      <Field label="Prompt" htmlFor="compare-agents-prompt">
        <Textarea
          id="compare-agents-prompt"
          placeholder="What should both agents answer?"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (!isSendShortcut(event)) return;
            event.preventDefault();
            void start();
          }}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Left">
          <ModelField
            environmentId={environmentId}
            entries={entries}
            selection={left}
            onChange={setLeftChoice}
          />
        </Field>
        <Field label="Right">
          <ModelField
            environmentId={environmentId}
            entries={entries}
            selection={right}
            onChange={setRightChoice}
          />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!left || !right}
          onClick={() => {
            setLeftChoice(right);
            setRightChoice(left);
          }}
        >
          Swap sides
        </Button>
        <Button disabled={!canStart} onClick={() => void start()}>
          {starting ? <Spinner /> : null}
          Start comparison
        </Button>
      </div>
    </div>
  );
}

function EarlierComparisons(props: {
  environmentId: EnvironmentId;
  renamingPairId: string | null;
  onOpenMenu: OpenPairMenu;
  onFinishRename: FinishRename;
}) {
  const shells = useThreadShells();
  const pairs = useMemo(
    () =>
      groupComparePairs(
        shells.filter((shell) => shell.archivedAt === null),
        props.environmentId,
      ),
    [shells, props.environmentId],
  );
  if (pairs.length === 0) return null;
  return (
    <div className="mx-auto max-w-2xl space-y-2 pt-8">
      <h3 className="text-sm font-medium">Earlier comparisons</h3>
      <ul className="divide-y rounded-lg border">
        {pairs.map((pair) => (
          <ComparePairRow
            key={pair.pairId}
            environmentId={props.environmentId}
            pair={pair}
            renaming={props.renamingPairId === pair.pairId}
            onOpenMenu={(position) => props.onOpenMenu(pair.pairId, position)}
            onFinishRename={(name) => props.onFinishRename(pair.pairId, name)}
          />
        ))}
      </ul>
    </div>
  );
}

/** Archived comparisons, loaded only while the section is open. */
function ArchivedComparisons(props: {
  environmentId: EnvironmentId;
  onOpenMenu: (pair: ComparePair, position: { x: number; y: number }) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-auto max-w-2xl space-y-2 pt-6">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        Archived comparisons
      </Button>
      {open ? (
        <ArchivedComparisonList environmentId={props.environmentId} onOpenMenu={props.onOpenMenu} />
      ) : null}
    </div>
  );
}

function ArchivedComparisonList(props: {
  environmentId: EnvironmentId;
  onOpenMenu: (pair: ComparePair, position: { x: number; y: number }) => void;
}) {
  const environmentIds = useMemo(() => [props.environmentId], [props.environmentId]);
  const { snapshots, error, isLoading } = useArchivedThreadSnapshots(environmentIds);
  const pairs = useMemo(
    () =>
      groupComparePairs(
        snapshots.flatMap(({ environmentId, snapshot }) =>
          snapshot.threads.map((thread) => presentThreadShell(environmentId, thread)),
        ),
        props.environmentId,
      ),
    [snapshots, props.environmentId],
  );
  if (error !== null) {
    return <p className="px-3 text-sm text-destructive-foreground">{error}</p>;
  }
  if (pairs.length === 0) {
    return (
      <p className="px-3 text-sm text-muted-foreground">
        {isLoading ? "Loading…" : "No archived comparisons."}
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-lg border">
      {pairs.map((pair) => (
        <ComparePairRow
          key={pair.pairId}
          environmentId={props.environmentId}
          pair={pair}
          archived
          renaming={false}
          onOpenMenu={(position) => props.onOpenMenu(pair, position)}
          onFinishRename={() => {}}
        />
      ))}
    </ul>
  );
}

/**
 * A comparison in a list. Opens on click (an archived one only offers its
 * menu); the menu opens from "…" or a right-click.
 */
function ComparePairRow(props: {
  environmentId: EnvironmentId;
  pair: ComparePair;
  archived?: boolean;
  renaming: boolean;
  onOpenMenu: (position: { x: number; y: number }) => void;
  onFinishRename: (name: string | null) => void;
}) {
  const { pair } = props;
  const navigate = useNavigate();
  const details = (
    <span className="block truncate text-xs text-muted-foreground">
      {pair.models.filter(Boolean).join(" vs ")}
    </span>
  );
  return (
    <li
      className="flex items-center gap-1 pe-2 hover:bg-accent/50"
      onContextMenu={(event) => {
        if (props.renaming) return;
        event.preventDefault();
        props.onOpenMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {props.renaming ? (
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2">
          <CompareRenameInput initial={pair.prompt} onFinish={props.onFinishRename} />
          {details}
        </div>
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
          onClick={(event) =>
            props.archived
              ? props.onOpenMenu(belowElement(event.currentTarget))
              : void navigate({
                  to: "/compare/$environmentId",
                  params: { environmentId: props.environmentId },
                  search: { pair: pair.pairId },
                })
          }
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{pair.prompt}</span>
            {details}
          </span>
          {pair.working ? <Spinner /> : null}
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatRelativeTimeLabel(pair.at)}
          </span>
        </button>
      )}
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={`Comparison actions for ${pair.prompt}`}
        aria-haspopup="menu"
        onClick={(event) => props.onOpenMenu(belowElement(event.currentTarget))}
      >
        <EllipsisIcon />
      </Button>
    </li>
  );
}

function ModelField(props: {
  environmentId: EnvironmentId;
  entries: ReadonlyArray<ProviderInstanceEntry>;
  selection: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
}) {
  const { selection, entries, onChange } = props;
  const settings = useEnvironmentSettings(props.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const modelOptions = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        providers,
        selection?.instanceId ?? null,
        selection?.model ?? null,
      ),
    [settings, providers, selection?.instanceId, selection?.model],
  );
  const entry = entries.find((candidate) => candidate.instanceId === selection?.instanceId);
  if (selection === null || entry === undefined) {
    return <p className="text-sm text-muted-foreground">No providers available</p>;
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={modelOptions}
        isComposerOwned={false}
        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
        onInstanceModelChange={(instanceId, model) =>
          onChange(createModelSelection(instanceId, model))
        }
      />
      <TraitsPicker
        provider={entry.driverKind}
        models={entry.models}
        model={selection.model}
        prompt=""
        onPromptChange={() => {}}
        modelOptions={selection.options ?? []}
        allowPromptInjectedEffort={false}
        planModeEnabled={settings.planModeEnabled}
        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
        onModelOptionsChange={(options) =>
          onChange(createModelSelection(selection.instanceId, selection.model, options))
        }
      />
    </div>
  );
}

function CompareResults(props: { environmentId: EnvironmentId; pairId: string }) {
  const { environmentId, pairId } = props;
  const [leftId, rightId] = compareThreadIds(pairId);
  const left = useThreadProjection(scopeThreadRef(environmentId, leftId));
  const right = useThreadProjection(scopeThreadRef(environmentId, rightId));
  const sides = [left?.projection ?? null, right?.projection ?? null] as const;
  const finished = sides.every((projection) => {
    if (projection === null) return false;
    const last = threadExchanges(projection).findLast((exchange) => exchange.run !== null);
    return last !== undefined && last.answer !== null && !last.answer.streaming;
  });
  // Review swaps already sent, to label the next round.
  const swapsSent =
    sides[0] === null
      ? 0
      : threadExchanges(sides[0]).filter((exchange) =>
          (exchange.prompt?.id ?? "").startsWith(COMPARE_REVIEW_MESSAGE_PREFIX),
        ).length;

  return (
    <>
      <div className="grid min-h-0 flex-1 grid-rows-2 divide-y lg:grid-cols-2 lg:grid-rows-1 lg:divide-x lg:divide-y-0">
        <CompareThreadColumn environmentId={environmentId} threadId={leftId} />
        <CompareThreadColumn environmentId={environmentId} threadId={rightId} />
      </div>
      <CompareComposer
        environmentId={environmentId}
        pairId={pairId}
        left={sides[0]}
        right={sides[1]}
        swapsSent={swapsSent}
        finished={finished}
      />
    </>
  );
}
