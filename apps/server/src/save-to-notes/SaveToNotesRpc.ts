/**
 * WebSocket handlers for Save to notes: each calls one SaveToNotes method.
 * Fork add-on: save to notes.
 *
 * @module save-to-notes/SaveToNotesRpc
 */
import { SAVE_TO_NOTES_WS_METHODS, type SaveToNotesInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import * as SaveToNotes from "./SaveToNotes.ts";

const traceAttributes = { "rpc.aggregate": "saveToNotes" };

export const makeHandlers = Effect.gen(function* () {
  const saveToNotes = yield* SaveToNotes.SaveToNotes;
  return {
    [SAVE_TO_NOTES_WS_METHODS.saveCopy]: (input: SaveToNotesInput) =>
      observeRpcEffect(
        SAVE_TO_NOTES_WS_METHODS.saveCopy,
        saveToNotes.saveCopy(input),
        traceAttributes,
      ),
    [SAVE_TO_NOTES_WS_METHODS.requestSummary]: (input: SaveToNotesInput) =>
      observeRpcEffect(
        SAVE_TO_NOTES_WS_METHODS.requestSummary,
        saveToNotes.requestSummary(input),
        traceAttributes,
      ),
  };
}).pipe(Effect.provide(SaveToNotes.layer));
