import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { CONFIRM_DIALOG_CHANNEL } from "./channels.ts";

const ConfirmDialogMessage = Schema.String.check(Schema.isMaxLength(4_000));

const splitConfirmDialogMessage = (message: string): { message: string; detail?: string } => {
  const lines = message.trim().split("\n");
  const title = lines.shift()?.trim() ?? "Confirm action";
  const detail = lines.join("\n").trim();
  return detail.length > 0 ? { message: title || "Confirm action", detail } : { message: title };
};

/**
 * Native confirmations stay above embedded WebContentsViews. Renderer-owned
 * dialogs are intentionally retained for the normal ndev.t3code surface, but a
 * remote app can cover that renderer region while it is active.
 */
export const confirm = DesktopIpc.makeIpcMethod({
  channel: CONFIRM_DIALOG_CHANNEL,
  payload: ConfirmDialogMessage,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.confirm")(function* (message) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const copy = splitConfirmDialogMessage(message);
    const result = yield* dialog.showMessageBox({
      type: "question",
      title: "ndev.t3code",
      message: copy.message,
      ...(copy.detail === undefined ? {} : { detail: copy.detail }),
      buttons: ["Cancel", "Confirm"],
      cancelId: 0,
      defaultId: 1,
      noLink: true,
    });
    return result.response === 1;
  }),
});
