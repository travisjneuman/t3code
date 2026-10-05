/**
 * Compare agents. `start` launches the same prompt as two new threads, one
 * per model, in a project or in "No project" (Scratch, where thread launch
 * gives each side a folder of its own); their ids derive from the pair id
 * (`compareThreadIds`), so the pair needs no stored record. `reviewSwap`
 * sends each thread the other's latest final answer, naming the provider,
 * model and options that produced it for the same prompts. `followUp` sends
 * one message to both, with each side's model and attachments and the
 * shared modes, and `stop` interrupts both. Fork add-on; see
 * docs/user/compare-agents.md.
 *
 * @module compare-agents/CompareAgents
 */
import {
  COMPARE_FOLLOW_UP_MESSAGE_PREFIX,
  COMPARE_REVIEW_MESSAGE_PREFIX,
  CommandId,
  type CompareAgentsEmptyResult,
  CompareAgentsError,
  type CompareAgentsFollowUpInput,
  type CompareAgentsFollowUpSide,
  type CompareAgentsReviewSwapInput,
  type CompareAgentsStartInput,
  type CompareAgentsStartResult,
  type CompareAgentsStopInput,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  compareThreadIds,
  modelSelectionLabel,
  providerInstanceLabel,
  runAnswer,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";

export class CompareAgents extends Context.Service<
  CompareAgents,
  {
    readonly start: (
      input: CompareAgentsStartInput,
    ) => Effect.Effect<CompareAgentsStartResult, CompareAgentsError>;
    readonly reviewSwap: (
      input: CompareAgentsReviewSwapInput,
    ) => Effect.Effect<CompareAgentsEmptyResult, CompareAgentsError>;
    readonly followUp: (
      input: CompareAgentsFollowUpInput,
    ) => Effect.Effect<CompareAgentsEmptyResult, CompareAgentsError>;
    readonly stop: (
      input: CompareAgentsStopInput,
    ) => Effect.Effect<CompareAgentsEmptyResult, CompareAgentsError>;
  }
>()("t3/compare-agents/CompareAgents") {}

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

// Queued runs wait their turn; interrupting means the run a provider is on now.
const INTERRUPTIBLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

const TITLE_PROMPT_MAX = 60;

const failed = (message: string) => (cause: unknown) => new CompareAgentsError({ message, cause });

const quote = (text: string): string =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");

const threadTitle = (prompt: string, selection: ModelSelection): string => {
  const line = prompt.replace(/\s+/g, " ").trim();
  const snippet = line.length > TITLE_PROMPT_MAX ? `${line.slice(0, TITLE_PROMPT_MAX)}…` : line;
  return `Compare · ${selection.model} · ${snippet}`;
};

/** The thread's latest finished answer and who wrote it. */
const latestAnswer = (projection: OrchestrationV2ThreadProjection) => {
  const run = projection.runs
    .filter((candidate) => candidate.status !== "rolled_back")
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  if (run === undefined) return null;
  const answer = runAnswer(projection, run);
  if (answer === null || answer.streaming) return null;
  return {
    text: answer.text,
    agent: providerInstanceLabel(projection, run.providerInstanceId),
    model: modelSelectionLabel(run.modelSelection),
  };
};

const reviewText = (other: NonNullable<ReturnType<typeof latestAnswer>>): string =>
  [
    "Review swap. Another agent was given the exact same prompts you were given in this comparison.",
    `It ran on ${other.agent}, model ${other.model}.`,
    "",
    "Its latest answer:",
    "",
    quote(other.text),
    "",
    "Compare it with your latest answer. Say where each one is stronger or weaker and what either one missed or got wrong, then give your best answer, keeping whatever is good from both.",
  ].join("\n");

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const crypto = yield* Crypto.Crypto;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;

  const start = Effect.fn("CompareAgents.start")(function* (input: CompareAgentsStartInput) {
    const pairId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(failed("Could not start the comparison.")),
    );
    const projectId =
      input.projectId ??
      (yield* managedFolders.ensureScratchProject.pipe(
        Effect.mapError(failed("Could not start without a project.")),
      )).projectId;
    const [leftId, rightId] = compareThreadIds(pairId);
    const sides = [
      { threadId: leftId, selection: input.left, side: "a" },
      { threadId: rightId, selection: input.right, side: "b" },
    ] as const;
    for (const { threadId, selection, side } of sides) {
      yield* threadLaunch
        .launch({
          commandId: CommandId.make(`compare-agents:${pairId}:${side}`),
          threadId,
          projectId,
          title: threadTitle(input.prompt, selection),
          generateTitle: false,
          modelSelection: selection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy: { type: "root" },
          initialMessage: { text: input.prompt, attachments: [] },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.mapError(failed(`Could not start ${selection.model}.`)));
    }
    return { pairId };
  });

  const readThread = (threadId: ThreadId) =>
    orchestrator
      .getThreadProjection(threadId)
      .pipe(Effect.mapError(failed("A thread in this comparison could not be read.")));

  const readPair = Effect.fn("CompareAgents.readPair")(function* (pairId: string) {
    const [leftId, rightId] = compareThreadIds(pairId);
    const left = yield* readThread(leftId);
    const right = yield* readThread(rightId);
    return [left, right] as const;
  });

  const requireIdle = Effect.fn("CompareAgents.requireIdle")(function* (
    sides: ReadonlyArray<OrchestrationV2ThreadProjection>,
  ) {
    if (sides.some((side) => side.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)))) {
      return yield* new CompareAgentsError({ message: "Wait for both agents to finish first." });
    }
  });

  /**
   * Sends each side its text as a user message under `prefix`, on the side's
   * own model unless the send names one.
   */
  const sendToBoth = Effect.fn("CompareAgents.sendToBoth")(function* (
    prefix: string,
    sends: ReadonlyArray<{
      readonly projection: OrchestrationV2ThreadProjection;
      readonly text: string;
      readonly side: "a" | "b";
      readonly with?: CompareAgentsFollowUpSide;
    }>,
  ) {
    const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(failed("Could not send.")));
    for (const { projection, text, side, with: sideInput } of sends) {
      const modelSelection = sideInput?.modelSelection ?? projection.thread.modelSelection;
      yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "server",
          commandId: CommandId.make(`${prefix}${id}:${side}`),
          threadId: projection.thread.id,
          messageId: MessageId.make(`${prefix}${id}:${side}`),
          text,
          attachments: sideInput?.attachments ?? [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.mapError(failed(`Could not send to ${modelSelection.model}.`)));
    }
  });

  /** Brings a side's Build/Plan and access modes to the follow-up's, as the composer does on send. */
  const applyModes = Effect.fn("CompareAgents.applyModes")(function* (
    projection: OrchestrationV2ThreadProjection,
    modes: { readonly interactionMode: ProviderInteractionMode; readonly runtimeMode: RuntimeMode },
  ) {
    const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(failed("Could not send.")));
    const threadId = projection.thread.id;
    if (projection.thread.runtimeMode !== modes.runtimeMode) {
      yield* orchestrator
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(`compare-agents-mode:${id}:runtime`),
          threadId,
          runtimeMode: modes.runtimeMode,
        })
        .pipe(Effect.mapError(failed("Could not change the access mode.")));
    }
    if (projection.thread.interactionMode !== modes.interactionMode) {
      yield* orchestrator
        .dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make(`compare-agents-mode:${id}:interaction`),
          threadId,
          interactionMode: modes.interactionMode,
        })
        .pipe(Effect.mapError(failed("Could not change Build or Plan mode.")));
    }
  });

  const reviewSwap = Effect.fn("CompareAgents.reviewSwap")(function* (
    input: CompareAgentsReviewSwapInput,
  ) {
    const [left, right] = yield* readPair(input.pairId);
    yield* requireIdle([left, right]);
    const leftAnswer = latestAnswer(left);
    const rightAnswer = latestAnswer(right);
    if (leftAnswer === null || rightAnswer === null) {
      return yield* new CompareAgentsError({
        message: "Both agents need a finished answer before a review swap.",
      });
    }
    yield* sendToBoth(COMPARE_REVIEW_MESSAGE_PREFIX, [
      { projection: left, text: reviewText(rightAnswer), side: "a" },
      { projection: right, text: reviewText(leftAnswer), side: "b" },
    ]);
    return {};
  });

  const followUp = Effect.fn("CompareAgents.followUp")(function* (
    input: CompareAgentsFollowUpInput,
  ) {
    const [left, right] = yield* readPair(input.pairId);
    yield* requireIdle([left, right]);
    yield* applyModes(left, input);
    yield* applyModes(right, input);
    yield* sendToBoth(COMPARE_FOLLOW_UP_MESSAGE_PREFIX, [
      { projection: left, text: input.text, side: "a", with: input.left },
      { projection: right, text: input.text, side: "b", with: input.right },
    ]);
    return {};
  });

  const stop = Effect.fn("CompareAgents.stop")(function* (input: CompareAgentsStopInput) {
    const sides = yield* readPair(input.pairId);
    const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(failed("Could not stop.")));
    for (const projection of sides) {
      const run = projection.runs.findLast((candidate) =>
        INTERRUPTIBLE_RUN_STATUSES.has(candidate.status),
      );
      if (run === undefined) continue;
      yield* orchestrator
        .dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`compare-agents-stop:${id}:${run.id}`),
          threadId: projection.thread.id,
          runId: run.id,
          holdQueue: true,
        })
        .pipe(Effect.mapError(failed("Could not stop an agent.")));
    }
    return {};
  });

  return CompareAgents.of({ start, reviewSwap, followUp, stop });
});

export const layer = Layer.effect(CompareAgents, make);
