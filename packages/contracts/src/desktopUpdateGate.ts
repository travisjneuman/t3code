// Fork add-on: the desktop bridge that holds update restarts while sessions are active.
import * as Schema from "effect/Schema";

import type { DesktopUpdateActionResult } from "./ipc.ts";

/** The app's restart into a downloaded update, held while sessions on this machine are active. */
export const DesktopUpdateGateStateSchema = Schema.Struct({
  /** Epoch milliseconds when the install was held; null when nothing waits. */
  queuedAt: Schema.NullOr(Schema.Number),
});
export type DesktopUpdateGateState = typeof DesktopUpdateGateStateSchema.Type;

export interface DesktopUpdateGateBridge {
  /** Tells the app how many sessions on this machine are active right now. */
  reportBusySessions: (count: number) => Promise<void>;
  getState: () => Promise<DesktopUpdateGateState>;
  /** Holds the install and resolves true while this machine is not yet idle. */
  holdInstallIfBusy: () => Promise<boolean>;
  /** Installs the downloaded update now, even with sessions active. */
  installNow: () => Promise<DesktopUpdateActionResult>;
  /** Drops a held install; the update stays downloaded. */
  cancel: () => Promise<void>;
  onStateChange: (listener: (state: DesktopUpdateGateState) => void) => () => void;
}

declare module "./ipc.ts" {
  interface DesktopBridge {
    /** Present in desktop builds; holds update restarts while sessions are active. */
    updateGate?: DesktopUpdateGateBridge;
  }
}
