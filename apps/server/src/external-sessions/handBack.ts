/**
 * "Hand back" for a continued thread: one message on the agent the session
 * came from, with the model and options it was continued with. The
 * orchestrator puts what other agents did since that agent's last turn into
 * the message as a context handoff, and the provider resumes its own session,
 * so the other app sees that work from then on. Turns another agent ran never
 * reach the original session otherwise. Fork add-on; see
 * docs/internals/external-sessions.md.
 *
 * @module external-sessions/handBack
 */
import {
  CommandId,
  continuedThreadOriginInstanceId,
  ExternalSessionError,
  MessageId,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const failed = (message: string) => (cause: unknown) =>
  new ExternalSessionError({ message, cause });

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventStore = yield* EventStore.EventStoreV2;
  const crypto = yield* Crypto.Crypto;

  /**
   * What the thread was continued with: its `thread.created` event. Falls back
   * to the first run on the origin instance for threads made some other way.
   */
  const originSelection = (
    projection: OrchestrationV2ThreadProjection,
    origin: ModelSelection["instanceId"],
  ) =>
    Effect.gen(function* () {
      const created = yield* eventStore
        .read({ threadId: projection.thread.id, eventType: "thread.created", limit: 1 })
        .pipe(Stream.runHead, Effect.mapError(failed("This thread's history could not be read.")));
      const fromCreated = Option.flatMap(created, ({ event }) =>
        event.type === "thread.created" && event.payload.modelSelection.instanceId === origin
          ? Option.some(event.payload.modelSelection)
          : Option.none(),
      );
      if (Option.isSome(fromCreated)) return fromCreated.value;
      return (
        projection.runs.find((run) => run.providerInstanceId === origin)?.modelSelection ?? null
      );
    });

  const handBack = Effect.fn("ExternalSessions.handBack")(function* (threadId: ThreadId) {
    const origin = continuedThreadOriginInstanceId(threadId);
    if (origin === null) {
      return yield* new ExternalSessionError({
        message: "This thread was not continued from another app.",
      });
    }
    const projection = yield* orchestrator
      .getThreadProjection(threadId)
      .pipe(Effect.mapError(failed("This thread could not be read.")));
    const modelSelection = yield* originSelection(projection, origin);
    if (modelSelection === null) {
      return yield* new ExternalSessionError({
        message: "The model this session was continued with is not recorded.",
      });
    }
    const driver = projection.providerThreads.find(
      (thread) => thread.providerInstanceId === origin,
    )?.driver;
    const name = driver === undefined ? origin : (PROVIDER_DISPLAY_NAMES[driver] ?? origin);
    const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(failed("Could not hand back.")));
    const active = projection.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));
    yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "server",
        commandId: CommandId.make(`external-session-hand-back:${id}`),
        threadId,
        messageId: MessageId.make(`external-session-hand-back:${id}`),
        text: `Handing back to ${name}.`,
        attachments: [],
        modelSelection,
        dispatchMode: active ? { type: "queue_after_active" } : { type: "start_immediately" },
      })
      .pipe(Effect.mapError(failed(`Could not hand back to ${name}.`)));
    return {};
  });

  return { handBack };
});
