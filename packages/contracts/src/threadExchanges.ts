/**
 * A thread read as prompt-and-answer pairs: each run's prompt with the last
 * thing the agent said in it, without tool output. History imported without
 * runs (continued sessions, V1 imports) pairs each user message with the
 * assistant messages that follow it. Shared by Save to notes and Compare
 * agents. Fork add-on.
 */
import * as DateTime from "effect/DateTime";

import { PROVIDER_DISPLAY_NAMES } from "./model.ts";
import type { ModelSelection } from "./modelSelection.ts";
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "./orchestrationV2.ts";

export interface ThreadExchangeAnswer {
  readonly text: string;
  /** Still being written; a saved copy leaves it out. */
  readonly streaming: boolean;
}

export interface ThreadExchange {
  /** Null for imported history, which has no runs. */
  readonly run: OrchestrationV2Run | null;
  /** Null when T3 or an agent started the run without a stored message. */
  readonly prompt: OrchestrationV2ConversationMessage | null;
  readonly answer: ThreadExchangeAnswer | null;
  readonly at: DateTime.Utc;
}

type ExchangeSource = Pick<OrchestrationV2ThreadProjection, "runs" | "messages" | "turnItems">;

const hasText = (text: string) => text.trim().length > 0;

/** "Codex" for a run on the codex instance, from the driver its provider thread records. */
export const providerInstanceLabel = (
  projection: Pick<OrchestrationV2ThreadProjection, "providerThreads">,
  instanceId: ModelSelection["instanceId"],
): string => {
  const driver = projection.providerThreads.find(
    (thread) => thread.providerInstanceId === instanceId,
  )?.driver;
  return (driver === undefined ? undefined : PROVIDER_DISPLAY_NAMES[driver]) ?? instanceId;
};

/** "gpt-5.5 (reasoningEffort=high)": the model and every option it ran with. */
export const modelSelectionLabel = (selection: ModelSelection): string => {
  const options = (selection.options ?? []).map((option) => `${option.id}=${String(option.value)}`);
  return options.length === 0 ? selection.model : `${selection.model} (${options.join(", ")})`;
};

/** The run's newest assistant text: its last message, else its last assistant item. */
export const runAnswer = (
  projection: Pick<ExchangeSource, "messages" | "turnItems">,
  run: OrchestrationV2Run,
): ThreadExchangeAnswer | null => {
  let message: OrchestrationV2ConversationMessage | null = null;
  for (const candidate of projection.messages) {
    if (candidate.runId !== run.id || candidate.role !== "assistant" || !hasText(candidate.text)) {
      continue;
    }
    if (
      message === null ||
      DateTime.toEpochMillis(candidate.updatedAt) >= DateTime.toEpochMillis(message.updatedAt)
    ) {
      message = candidate;
    }
  }
  if (message !== null) return { text: message.text, streaming: message.streaming };
  let item: Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }> | null = null;
  for (const candidate of projection.turnItems) {
    if (
      candidate.runId === run.id &&
      candidate.type === "assistant_message" &&
      hasText(candidate.text) &&
      (item === null || candidate.ordinal >= item.ordinal)
    ) {
      item = candidate;
    }
  }
  return item === null ? null : { text: item.text, streaming: item.streaming };
};

export const threadExchanges = (projection: ExchangeSource): ReadonlyArray<ThreadExchange> => {
  const messagesById = new Map(projection.messages.map((message) => [message.id, message]));
  const runPrompts = new Set(projection.runs.map((run) => run.userMessageId));
  const exchanges: Array<ThreadExchange> = projection.runs
    .filter((run) => run.status !== "rolled_back")
    .map((run) => ({
      run,
      prompt: messagesById.get(run.userMessageId) ?? null,
      answer: runAnswer(projection, run),
      at: run.requestedAt,
    }));

  const runless = projection.messages
    .filter(
      (message) =>
        message.runId === null && message.role !== "system" && !runPrompts.has(message.id),
    )
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
    );
  let current: { prompt: OrchestrationV2ConversationMessage | null; at: DateTime.Utc } | null =
    null;
  let answer: ThreadExchangeAnswer | null = null;
  const flush = () => {
    if (current !== null) exchanges.push({ run: null, ...current, answer });
  };
  for (const message of runless) {
    if (message.role === "user") {
      flush();
      current = { prompt: message, at: message.createdAt };
      answer = null;
    } else if (hasText(message.text)) {
      current ??= { prompt: null, at: message.createdAt };
      answer = { text: message.text, streaming: message.streaming };
    }
  }
  flush();

  return exchanges.toSorted(
    (left, right) => DateTime.toEpochMillis(left.at) - DateTime.toEpochMillis(right.at),
  );
};
