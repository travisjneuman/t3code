/**
 * Compare agents page. Without a pair it is the setup form, one prompt and
 * two models, above the list of earlier comparisons. With a pair it shows
 * both threads' prompts and answers side by side, with Review swap and a
 * docked follow-up box that sends to both, or stops both while they work.
 * Fork add-on: compare agents; see docs/user/compare-agents.md.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  COMPARE_FOLLOW_UP_MESSAGE_PREFIX,
  COMPARE_REVIEW_MESSAGE_PREFIX,
  comparePairOf,
  compareThreadIds,
  type EnvironmentId,
  type ModelSelection,
  modelSelectionLabel,
  type OrchestrationV2ThreadProjection,
  providerInstanceLabel,
  type ThreadExchange,
  threadExchanges,
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { CheckIcon, CopyIcon, PlusIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { ComposerSurface } from "../components/chat/ComposerSurface";
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import { scheduledTaskDefaultModel } from "../components/settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../components/settings/settingsLayout";
import { Badge } from "../components/ui/badge";
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
import { isElectron } from "../env";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { useProjects, useThreadProjection, useThreadShells } from "../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { reviewSwap, sendFollowUp, startComparison, stopComparison } from "./compareAgents";

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const isWorking = (projection: OrchestrationV2ThreadProjection | null) =>
  projection?.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? false;

const isSendShortcut = (event: KeyboardEvent) =>
  event.key === "Enter" && (event.metaKey || event.ctrlKey);

export function CompareAgentsView(props: {
  environmentId: EnvironmentId;
  pairId: string | undefined;
  projectId: string | undefined;
  fromThreadId: string | undefined;
}) {
  const navigate = useNavigate();
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
      >
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">Compare agents</h2>
        {props.pairId !== undefined ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void navigate({
                to: "/compare/$environmentId",
                params: { environmentId: props.environmentId },
                search: {},
              })
            }
          >
            <PlusIcon />
            New comparison
          </Button>
        ) : null}
      </header>
      {props.pairId !== undefined ? (
        <CompareResults environmentId={props.environmentId} pairId={props.pairId} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6">
          {props.fromThreadId !== undefined ? (
            <CompareSetupFromThread
              environmentId={props.environmentId}
              threadId={props.fromThreadId}
            />
          ) : (
            <CompareSetup
              environmentId={props.environmentId}
              initialProjectId={props.projectId}
              initialPrompt=""
              initialLeft={null}
            />
          )}
          <EarlierComparisons environmentId={props.environmentId} />
        </div>
      )}
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

/** The setup form prefilled from a thread: its project, model, and latest prompt. */
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
  const [prompt, setPrompt] = useState(props.initialPrompt);
  const [leftChoice, setLeftChoice] = useState<ModelSelection | null>(props.initialLeft);
  const [rightChoice, setRightChoice] = useState<ModelSelection | null>(null);
  const [starting, setStarting] = useState(false);

  const project = projects.find((candidate) => candidate.id === projectId) ?? projects[0] ?? null;
  const leftDefault = scheduledTaskDefaultModel(settings, project, entries);
  const left = leftChoice ?? leftDefault;
  const right = rightChoice ?? otherDefaultModel(entries, left);
  const canStart = !starting && project !== null && prompt.trim() !== "" && !!left && !!right;

  const start = async () => {
    if (!canStart || project === null || !left || !right) return;
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

/** "Compare · gpt-5.5 · the prompt" → "the prompt"; a renamed thread keeps its title. */
const comparePromptOf = (title: string): string => {
  const parts = title.split(" · ");
  return parts[0] === "Compare" && parts.length >= 3 ? parts.slice(2).join(" · ") : title;
};

function EarlierComparisons(props: { environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const shells = useThreadShells();
  const pairs = useMemo(() => {
    const byPair = new Map<
      string,
      { pairId: string; prompt: string; models: string[]; at: string; working: boolean }
    >();
    for (const shell of shells) {
      if (shell.environmentId !== props.environmentId || shell.archivedAt !== null) continue;
      const pair = comparePairOf(shell.id);
      if (pair === null) continue;
      const entry = byPair.get(pair.pairId) ?? {
        pairId: pair.pairId,
        prompt: comparePromptOf(shell.title),
        models: [],
        at: shell.createdAt,
        working: false,
      };
      entry.models[pair.side === "a" ? 0 : 1] = shell.modelSelection.model;
      entry.working ||= ACTIVE_RUN_STATUSES.has(shell.latestRun?.status ?? "");
      if (shell.updatedAt > entry.at) entry.at = shell.updatedAt;
      byPair.set(pair.pairId, entry);
    }
    return [...byPair.values()].toSorted((left, right) => right.at.localeCompare(left.at));
  }, [shells, props.environmentId]);
  if (pairs.length === 0) return null;
  return (
    <div className="mx-auto max-w-2xl space-y-2 pt-8">
      <h3 className="text-sm font-medium">Earlier comparisons</h3>
      <ul className="divide-y rounded-lg border">
        {pairs.map((pair) => (
          <li key={pair.pairId}>
            <button
              type="button"
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/50"
              onClick={() =>
                void navigate({
                  to: "/compare/$environmentId",
                  params: { environmentId: props.environmentId },
                  search: { pair: pair.pairId },
                })
              }
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{pair.prompt}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {pair.models.filter(Boolean).join(" vs ")}
                </span>
              </span>
              {pair.working ? <Spinner /> : null}
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatRelativeTimeLabel(pair.at)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Each side is a normal thread, so archiving both threads removes a comparison from this list.
      </p>
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

/** What sent an exchange's prompt: the user's first prompt, a follow-up, or a review swap. */
type ExchangeKind = "prompt" | "follow-up" | "review";

const exchangeKind = (exchange: ThreadExchange): ExchangeKind => {
  const id = exchange.prompt?.id ?? "";
  if (id.startsWith(COMPARE_REVIEW_MESSAGE_PREFIX)) return "review";
  if (id.startsWith(COMPARE_FOLLOW_UP_MESSAGE_PREFIX)) return "follow-up";
  return "prompt";
};

function CompareResults(props: { environmentId: EnvironmentId; pairId: string }) {
  const { environmentId, pairId } = props;
  const [leftId, rightId] = compareThreadIds(pairId);
  const left = useThreadProjection(scopeThreadRef(environmentId, leftId));
  const right = useThreadProjection(scopeThreadRef(environmentId, rightId));
  const [pending, setPending] = useState<"swap" | "stop" | "follow-up" | null>(null);
  const [followUp, setFollowUp] = useState("");
  const sides = [left?.projection ?? null, right?.projection ?? null];
  const working = sides.some(isWorking);
  const finished = sides.every((projection) => {
    if (projection === null) return false;
    const last = threadExchanges(projection).findLast((exchange) => exchange.run !== null);
    return last !== undefined && last.answer !== null && !last.answer.streaming;
  });
  const swapsSent =
    sides[0] === null
      ? 0
      : threadExchanges(sides[0]).filter((exchange) => exchangeKind(exchange) === "review").length;

  const run = async (kind: NonNullable<typeof pending>, action: () => Promise<boolean>) => {
    setPending(kind);
    const ok = await action();
    setPending(null);
    return ok;
  };
  const sendToBoth = async () => {
    const text = followUp.trim();
    if (text === "" || working || pending !== null) return;
    if (await run("follow-up", () => sendFollowUp(environmentId, pairId, text))) setFollowUp("");
  };

  return (
    <>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pt-4 pb-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={pending !== null || working || !finished}
            onClick={() => void run("swap", () => reviewSwap(environmentId, pairId))}
          >
            {pending === "swap" ? <Spinner /> : null}
            {swapsSent === 0 ? "Review swap" : `Review swap (round ${swapsSent + 1})`}
          </Button>
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {working
              ? "Waiting for both agents to finish."
              : finished
                ? "Review swap sends each agent the other's newest answer and asks it to compare and improve."
                : "Review swap needs a finished answer from both agents."}
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <CompareColumn environmentId={environmentId} threadId={leftId} thread={left} />
          <CompareColumn environmentId={environmentId} threadId={rightId} thread={right} />
        </div>
      </div>
      <FollowUpComposer
        value={followUp}
        onChange={setFollowUp}
        working={working}
        pending={pending}
        onSend={() => void sendToBoth()}
        onStop={() => void run("stop", () => stopComparison(environmentId, pairId))}
      />
    </>
  );
}

// ComposerPrimaryActions' round send and stop buttons, without the stage backdrop art.
const ROUND_ACTION_CLASS =
  "relative isolate flex size-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:size-8 [&_svg]:pointer-events-none";

/**
 * The follow-up box, docked under the results in ChatComposer's lane, surface
 * and toolbar. While either agent works, its round button stops both instead.
 */
function FollowUpComposer(props: {
  value: string;
  onChange: (value: string) => void;
  working: boolean;
  pending: "swap" | "stop" | "follow-up" | null;
  onSend: () => void;
  onStop: () => void;
}) {
  const { value, working, pending } = props;
  const canSend = !working && pending === null && value.trim() !== "";
  return (
    <div className="chat-composer-lane w-full shrink-0 pt-1.5 sm:pt-2">
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <div className="relative z-10">
            <ComposerSurface.Main>
              <div className="rounded-3xl">
                <div className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4">
                  <textarea
                    aria-label="Follow-up for both agents"
                    className="block field-sizing-content max-h-50 min-h-12 w-full resize-none bg-transparent font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) leading-relaxed text-foreground outline-none placeholder:text-placeholder max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)"
                    placeholder={
                      working
                        ? "Both agents are working. You can send once they finish."
                        : "Ask both agents the same follow-up…"
                    }
                    value={value}
                    onChange={(event) => props.onChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (!isSendShortcut(event)) return;
                      event.preventDefault();
                      if (canSend) props.onSend();
                    }}
                  />
                </div>
                <div className="flex min-w-0 flex-nowrap items-center justify-between gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
                  <p className="min-w-0 truncate text-xs text-muted-foreground">
                    Sends to both agents. Each sees only its own thread.
                  </p>
                  {working ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            className={cn(
                              ROUND_ACTION_CLASS,
                              "bg-destructive/90 text-white shadow-destructive/24 hover:bg-destructive",
                            )}
                            disabled={pending !== null}
                            onClick={props.onStop}
                            aria-label="Stop both agents"
                          />
                        }
                      >
                        {pending === "stop" ? (
                          <Spinner size="sm" aria-hidden="true" />
                        ) : (
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 12 12"
                            fill="currentColor"
                            aria-hidden="true"
                          >
                            <rect x="2" y="2" width="8" height="8" rx="1.5" />
                          </svg>
                        )}
                      </TooltipTrigger>
                      <TooltipPopup>Stop both</TooltipPopup>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            className={cn(
                              ROUND_ACTION_CLASS,
                              "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover",
                            )}
                            disabled={!canSend}
                            onClick={props.onSend}
                            aria-label="Send to both"
                          />
                        }
                      >
                        {pending === "follow-up" ? (
                          <Spinner size="sm" aria-hidden="true" />
                        ) : (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 14 14"
                            fill="none"
                            aria-hidden="true"
                          >
                            <path
                              d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </TooltipTrigger>
                      <TooltipPopup>Send to both (Ctrl/⌘ Enter)</TooltipPopup>
                    </Tooltip>
                  )}
                </div>
              </div>
            </ComposerSurface.Main>
          </div>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
      <div
        aria-hidden
        className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
      />
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
  const working = isWorking(projection);
  let swapRound = 0;
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
      <div className="space-y-6 px-4 py-4">
        {exchanges.map((exchange, index) => {
          const kind = exchangeKind(exchange);
          if (kind === "review") swapRound += 1;
          return (
            <ExchangeView
              key={exchange.run?.id ?? exchange.prompt?.id ?? index}
              exchange={exchange}
              label={
                kind === "review"
                  ? `Review swap ${swapRound} · sent by T3`
                  : kind === "follow-up"
                    ? "Your follow-up"
                    : "Your prompt"
              }
              cwd={cwd}
              pending={working && index === exchanges.length - 1}
            />
          );
        })}
      </div>
    </section>
  );
}

const STOPPED_LABELS: Partial<Record<string, string>> = {
  interrupted: "Stopped",
  cancelled: "Cancelled",
  failed: "Failed",
};

const runDuration = (exchange: ThreadExchange): string | null => {
  const run = exchange.run;
  if (run === null || run.startedAt === null || run.completedAt === null) return null;
  return formatDuration(
    DateTime.toEpochMillis(run.completedAt) - DateTime.toEpochMillis(run.startedAt),
  );
};

function ExchangeView(props: {
  exchange: ThreadExchange;
  label: string;
  cwd: string | undefined;
  pending: boolean;
}) {
  const { exchange } = props;
  const [expanded, setExpanded] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const prompt = exchange.prompt?.text ?? null;
  const long = prompt !== null && (prompt.length > 400 || prompt.split("\n").length > 4);
  const stopped = exchange.run === null ? undefined : STOPPED_LABELS[exchange.run.status];
  const duration = runDuration(exchange);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{props.label}</span>
        {stopped !== undefined ? <Badge variant="warning">{stopped}</Badge> : null}
        {duration !== null ? <span>{duration}</span> : null}
      </div>
      {prompt !== null ? (
        <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          <p className={cn("whitespace-pre-wrap", !expanded && long && "line-clamp-4")}>{prompt}</p>
          {long ? (
            <div className="mt-1">
              <Button size="xs" variant="link" onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Show less" : "Show full message"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {exchange.answer !== null ? (
        <div className="space-y-1">
          <ChatMarkdown
            text={exchange.answer.text}
            cwd={props.cwd}
            isStreaming={exchange.answer.streaming}
          />
          {!exchange.answer.streaming ? (
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => copyToClipboard(exchange.answer?.text ?? "", undefined)}
            >
              {isCopied ? <CheckIcon /> : <CopyIcon />}
              {isCopied ? "Copied" : "Copy answer"}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{props.pending ? "Working…" : "No answer."}</p>
      )}
    </div>
  );
}
