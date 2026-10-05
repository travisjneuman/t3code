/**
 * Compare agents page. Without a pair it is the setup form: one prompt, two
 * models. With a pair it shows both threads' prompts and answers side by
 * side, and offers Review swap once both agents have finished.
 * Fork add-on: compare agents; see docs/user/compare-agents.md.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  compareThreadIds,
  type EnvironmentId,
  type ModelSelection,
  modelSelectionLabel,
  providerInstanceLabel,
  threadExchanges,
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import { scheduledTaskDefaultModel } from "../components/settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../components/settings/settingsLayout";
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
import { isElectron } from "../env";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { useProjects, useThreadProjection } from "../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { reviewSwap, startComparison } from "./compareAgents";

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export function CompareAgentsView(props: {
  environmentId: EnvironmentId;
  pairId: string | undefined;
  projectId: string | undefined;
}) {
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      <header
        className={cn(
          "relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center bg-background",
          isElectron
            ? "drag-region px-3 sm:px-5 wco:pr-(--workspace-native-controls-inset)"
            : "pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <h2 className="min-w-0 truncate text-sm font-medium">Compare agents</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6">
        {props.pairId === undefined ? (
          <CompareSetup environmentId={props.environmentId} initialProjectId={props.projectId} />
        ) : (
          <CompareResults environmentId={props.environmentId} pairId={props.pairId} />
        )}
      </div>
    </SidebarInset>
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

function CompareSetup(props: {
  environmentId: EnvironmentId;
  initialProjectId: string | undefined;
}) {
  const { environmentId } = props;
  const navigate = useNavigate();
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const [projectId, setProjectId] = useState(props.initialProjectId ?? "");
  const [prompt, setPrompt] = useState("");
  const [leftChoice, setLeftChoice] = useState<ModelSelection | null>(null);
  const [rightChoice, setRightChoice] = useState<ModelSelection | null>(null);
  const [starting, setStarting] = useState(false);

  const project = projects.find((candidate) => candidate.id === projectId) ?? projects[0] ?? null;
  const leftDefault = scheduledTaskDefaultModel(settings, project, entries);
  const left = leftChoice ?? leftDefault;
  const right = rightChoice ?? otherDefaultModel(entries, left);
  const canStart = !starting && project !== null && prompt.trim() !== "" && !!left && !!right;

  const start = async () => {
    if (starting || project === null || prompt.trim() === "" || !left || !right) return;
    setStarting(true);
    const pairId = await startComparison(environmentId, {
      projectId: project.id,
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

  if (projects.length === 0) {
    return <p className="pt-6 text-sm text-muted-foreground">Add a project first.</p>;
  }
  return (
    <div className="mx-auto max-w-2xl space-y-5 pt-4">
      <p className="text-sm text-muted-foreground">
        Send one prompt to two agents and see their answers side by side. Each side becomes its own
        thread. Both work in the project folder itself, so prefer questions and reviews over edits.
      </p>
      <Field label="Project">
        <Select value={project?.id ?? ""} onValueChange={(id) => setProjectId(String(id))}>
          <SelectTrigger size="sm">
            <SelectValue>{project?.title ?? "Pick a project"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
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
      <Button disabled={!canStart} onClick={() => void start()}>
        {starting ? <Spinner /> : null}
        Start comparison
      </Button>
    </div>
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
  const [swapping, setSwapping] = useState(false);
  const sides = [left?.projection ?? null, right?.projection ?? null];
  const working = sides.some(
    (projection) => projection?.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? false,
  );
  const finished = sides.every((projection) => {
    if (projection === null) return false;
    const last = threadExchanges(projection).findLast((exchange) => exchange.run !== null);
    return last !== undefined && last.answer !== null && !last.answer.streaming;
  });

  const swap = async () => {
    setSwapping(true);
    await reviewSwap(environmentId, pairId);
    setSwapping(false);
  };

  return (
    <div className="space-y-4 pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          disabled={swapping || working || !finished}
          onClick={() => void swap()}
        >
          {swapping ? <Spinner /> : null}
          Review swap
        </Button>
        <p className="text-sm text-muted-foreground">
          {working
            ? "Waiting for both agents to finish."
            : finished
              ? "Sends each agent the other's latest answer and asks it to compare and improve."
              : "Review swap needs an answer from both agents."}
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <CompareColumn environmentId={environmentId} threadId={leftId} thread={left} />
        <CompareColumn environmentId={environmentId} threadId={rightId} thread={right} />
      </div>
    </div>
  );
}

function CompareColumn(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  thread: ReturnType<typeof useThreadProjection>;
}) {
  const navigate = useNavigate();
  const projects = useProjects();
  const projection = props.thread?.projection ?? null;
  const exchanges = useMemo(
    () => (projection === null ? [] : threadExchanges(projection)),
    [projection],
  );
  if (projection === null) {
    return (
      <section className="rounded-lg border p-4 text-sm text-muted-foreground">
        Loading this side…
      </section>
    );
  }
  const selection = projection.thread.modelSelection;
  const cwd = projects.find(
    (project) =>
      project.environmentId === props.environmentId && project.id === projection.thread.projectId,
  )?.workspaceRoot;
  const working = projection.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));
  return (
    <section className="min-w-0 rounded-lg border">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {providerInstanceLabel(projection, selection.instanceId)}
          </p>
          <p className="truncate text-xs text-muted-foreground">{modelSelectionLabel(selection)}</p>
        </div>
        {working ? <Spinner /> : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(props.environmentId, props.threadId)),
            })
          }
        >
          Open thread
        </Button>
      </div>
      <div className="space-y-5 px-4 py-4">
        {exchanges.map((exchange, index) => (
          <div key={exchange.run?.id ?? exchange.prompt?.id ?? index} className="space-y-2">
            {exchange.prompt !== null ? (
              <p className="line-clamp-4 whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                {exchange.prompt.text}
              </p>
            ) : null}
            {exchange.answer !== null ? (
              <ChatMarkdown
                text={exchange.answer.text}
                cwd={cwd}
                isStreaming={exchange.answer.streaming}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {working && index === exchanges.length - 1 ? "Working…" : "No answer."}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
