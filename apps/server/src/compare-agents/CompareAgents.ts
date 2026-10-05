/**
 * Compare agents. `start` launches the same prompt as two new threads in one
 * project folder, one per model; their ids derive from the pair id
 * (`compareThreadIds`), so the pair needs no stored record. `reviewSwap`
 * sends each thread the other's latest final answer, naming the provider,
 * model and options that produced it for the same prompt. Fork add-on; see
 * docs/user/compare-agents.md.
 *
 * @module compare-agents/CompareAgents
 */
import {
  CommandId,
  CompareAgentsError,
  type CompareAgentsReviewSwapInput,
  type CompareAgentsReviewSwapResult,
  type CompareAgentsStartInput,
  type CompareAgentsStartResult,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
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

export class CompareAgents extends Context.Service<
  CompareAgents,
  {
    readonly start: (
      input: CompareAgentsStartInput,
    ) => Effect.Effect<CompareAgentsStartResult, CompareAgentsError>;
    readonly reviewSwap: (
      input: CompareAgentsReviewSwapInput,
    ) => Effect.Effect<CompareAgentsReviewSwapResult, CompareAgentsError>;
  }
>()("t3/compare-agents/CompareAgents") {}

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
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
    "Review swap. Another agent was given the exact same prompt you were given at the start of this comparison.",
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

  const start = Effect.fn("CompareAgents.start")(function* (input: CompareAgentsStartInput) {
    const pairId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(failed("Could not start the comparison.")),
    );
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
          projectId: input.projectId,
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

  const reviewSwap = Effect.fn("CompareAgents.reviewSwap")(function* (
    input: CompareAgentsReviewSwapInput,
  ) {
    const [leftId, rightId] = compareThreadIds(input.pairId);
    const left = yield* readThread(leftId);
    const right = yield* readThread(rightId);
    if (
      [left, right].some((side) => side.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)))
    ) {
      return yield* new CompareAgentsError({ message: "Wait for both agents to finish first." });
    }
    const leftAnswer = latestAnswer(left);
    const rightAnswer = latestAnswer(right);
    if (leftAnswer === null || rightAnswer === null) {
      return yield* new CompareAgentsError({
        message: "Both agents need a finished answer before a review swap.",
      });
    }
    const id = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(failed("Could not send the review swap.")),
    );
    const sends = [
      { projection: left, text: reviewText(rightAnswer), side: "a" },
      { projection: right, text: reviewText(leftAnswer), side: "b" },
    ] as const;
    for (const { projection, text, side } of sends) {
      yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "server",
          commandId: CommandId.make(`compare-agents-review:${id}:${side}`),
          threadId: projection.thread.id,
          messageId: MessageId.make(`compare-agents-review:${id}:${side}`),
          text,
          attachments: [],
          modelSelection: projection.thread.modelSelection,
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.mapError(failed("Could not send the review swap.")));
    }
    return {};
  });

  return CompareAgents.of({ start, reviewSwap });
});

export const layer = Layer.effect(CompareAgents, make);
