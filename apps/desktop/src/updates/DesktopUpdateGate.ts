// Fork add-on: maintenance queue. Holds the app's restart into a downloaded
// update while sessions on this computer are active, whoever asked for it: the
// update button, Update everything, or a remote client's desktop update. The
// held install runs once the window has reported no active sessions for
// MAINTENANCE_QUEUE_IDLE_MS. See docs/user/fork-updating.md.
import {
  type DesktopUpdateGateState,
  type DesktopUpdateState,
  MAINTENANCE_QUEUE_IDLE_MS,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../fork/channels.ts";

// The window repeats its count every 30 seconds; a count older than this means no
// window is counting, see `settledIdle`.
const BUSY_REPORT_TTL_MS = 5 * 60 * 1000;
const HELD_INSTALL_CHECK_INTERVAL = "15 seconds";

export interface HeldInstall {
  /** The version a remote client prepared; none for the local update button. */
  readonly expectedVersion: Option.Option<string>;
  readonly queuedAt: number;
}

interface BusyReport {
  readonly busySessions: number;
  readonly reportedAt: number;
  readonly idleSince: number;
}

export const HELD_INSTALL_MESSAGE =
  "Waiting for active sessions on this computer to finish before installing.";

/** Only an install the updater would accept is held; it refuses the rest as before. */
export const isHoldable = (
  state: DesktopUpdateState,
  expectedVersion: Option.Option<string>,
): boolean =>
  state.downloadedVersion !== null &&
  (Option.isNone(expectedVersion) || expectedVersion.value === state.downloadedVersion);

const { logInfo } = DesktopObservability.makeComponentLogger("desktop-update-gate");

export class DesktopUpdateGate extends Context.Service<
  DesktopUpdateGate,
  {
    readonly reportBusySessions: (count: number) => Effect.Effect<void>;
    readonly getState: Effect.Effect<DesktopUpdateGateState>;
    /** True when the install was held instead of allowed to run now. */
    readonly holdIfBusy: (expectedVersion: Option.Option<string>) => Effect.Effect<boolean>;
    /** Lets the next install through and drops the held one. */
    readonly allowNextInstall: Effect.Effect<void>;
    readonly cancel: Effect.Effect<void>;
    /** Waits until an install is held and this computer has settled idle, then releases it. */
    readonly takeReady: Effect.Effect<HeldInstall>;
  }
>()("t3/desktop/updates/DesktopUpdateGate") {}

const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const busyRef = yield* Ref.make<BusyReport>({ busySessions: 0, reportedAt: 0, idleSince: 0 });
  const heldRef = yield* Ref.make<Option.Option<HeldInstall>>(Option.none());
  const bypassRef = yield* Ref.make(false);

  const getState = Ref.get(heldRef).pipe(
    Effect.map((held): DesktopUpdateGateState => ({
      queuedAt: Option.isSome(held) ? held.value.queuedAt : null,
    })),
  );

  const publish = getState.pipe(
    Effect.flatMap((state) =>
      electronWindow.sendAll(IpcChannels.UPDATE_GATE_STATE_CHANGE_CHANNEL, state),
    ),
  );

  const settledIdle = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const report = yield* Ref.get(busyRef);
    // Only the window can count sessions. Without a fresh count the state is
    // unknown, and unknown is treated as idle so an install is never held on
    // a guess; the same rule the client applies to an unreachable Hermes.
    if (now - report.reportedAt > BUSY_REPORT_TTL_MS) return true;
    return report.busySessions === 0 && now - report.idleSince >= MAINTENANCE_QUEUE_IDLE_MS;
  });

  const reportBusySessions = (count: number) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const busySessions = Math.max(0, Math.floor(count));
      yield* Ref.update(busyRef, (previous) => ({
        busySessions,
        reportedAt: now,
        idleSince: busySessions > 0 || previous.busySessions > 0 ? now : previous.idleSince,
      }));
    });

  const holdIfBusy = (expectedVersion: Option.Option<string>) =>
    Effect.gen(function* () {
      if (yield* Ref.getAndSet(bypassRef, false)) return false;
      if (yield* settledIdle) return false;
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(heldRef, (held) =>
        Option.some({
          expectedVersion,
          queuedAt: Option.isSome(held) ? held.value.queuedAt : now,
        }),
      );
      yield* logInfo("holding the update install until sessions on this computer are idle", {
        busySessions: (yield* Ref.get(busyRef)).busySessions,
      });
      yield* publish;
      return true;
    });

  const clearHeld = Ref.set(heldRef, Option.none()).pipe(Effect.andThen(publish));

  const takeReady = Effect.gen(function* () {
    while (true) {
      const held = yield* Ref.get(heldRef);
      if (Option.isSome(held) && (yield* settledIdle)) {
        yield* clearHeld;
        return held.value;
      }
      yield* Effect.sleep(HELD_INSTALL_CHECK_INTERVAL);
    }
  });

  return DesktopUpdateGate.of({
    reportBusySessions,
    getState,
    holdIfBusy,
    allowNextInstall: Ref.set(bypassRef, true).pipe(Effect.andThen(clearHeld)),
    cancel: clearHeld,
    takeReady,
  });
});

export const layer = Layer.effect(DesktopUpdateGate, make);
