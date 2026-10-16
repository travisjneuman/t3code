// Fork add-on: IPC for the maintenance queue's hold on update restarts. The
// handlers need DesktopUpdateGate and DesktopUpdates, which
// ForkDesktopUpdates.layer provides.
import { DesktopUpdateActionResultSchema, DesktopUpdateGateStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../fork/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopUpdateGate from "./DesktopUpdateGate.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

export const reportBusySessions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_GATE_REPORT_BUSY_CHANNEL,
  payload: Schema.Number,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.updateGate.reportBusySessions")(function* (count: number) {
    yield* (yield* DesktopUpdateGate.DesktopUpdateGate).reportBusySessions(count);
  }),
});

export const getState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_GATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateGateStateSchema,
  handler: Effect.fn("desktop.ipc.updateGate.getState")(function* () {
    return yield* (yield* DesktopUpdateGate.DesktopUpdateGate).getState;
  }),
});

export const holdIfBusy = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_GATE_HOLD_IF_BUSY_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.updateGate.holdIfBusy")(function* () {
    const gate = yield* DesktopUpdateGate.DesktopUpdateGate;
    const updates = yield* DesktopUpdates.DesktopUpdates;
    if (!DesktopUpdateGate.isHoldable(yield* updates.getState, Option.none())) return false;
    return yield* gate.holdIfBusy(Option.none());
  }),
});

export const installNow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_GATE_INSTALL_NOW_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updateGate.installNow")(function* () {
    const gate = yield* DesktopUpdateGate.DesktopUpdateGate;
    const updates = yield* DesktopUpdates.DesktopUpdates;
    // The bypass is spent only by an install the gate would hold; one the
    // updater refuses anyway must not leave it armed for a later install.
    const holdable = DesktopUpdateGate.isHoldable(yield* updates.getState, Option.none());
    yield* holdable ? gate.allowNextInstall : gate.cancel;
    return yield* updates.install;
  }),
});

export const cancel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_GATE_CANCEL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.updateGate.cancel")(function* () {
    yield* (yield* DesktopUpdateGate.DesktopUpdateGate).cancel;
  }),
});

export const methods = [reportBusySessions, getState, holdIfBusy, installNow, cancel] as const;
