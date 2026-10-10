// Fork add-on: View menu items for remote apps. DesktopApplicationMenu splices
// these into its View menu; there are none when RemoteAppManager is absent.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as RemoteAppManager from "../remote-apps/RemoteAppManager.ts";

const { logWarning: logMenuWarning } = makeComponentLogger("desktop-menu");

export const make = Effect.gen(function* () {
  const remoteAppManager = yield* Effect.serviceOption(RemoteAppManager.RemoteAppManager);
  if (Option.isNone(remoteAppManager)) {
    return { viewItems: [] as Electron.MenuItemConstructorOptions[] };
  }
  const manager = remoteAppManager.value;

  // Acts on the web app whose page has focus, else the one on screen.
  const textSizeClick = (step: RemoteAppManager.RemoteAppTextSizeStep) => () => {
    void Effect.runPromise(
      manager
        .stepTextSize(step)
        .pipe(
          Effect.catch((error) =>
            logMenuWarning("failed to change web app text size", { error: error.message }),
          ),
        ),
    ).catch(() => undefined);
  };

  const viewItems: Electron.MenuItemConstructorOptions[] = [
    { type: "separator" },
    {
      label: "Web App Text Larger",
      accelerator: "Alt+CmdOrCtrl+=",
      click: textSizeClick("larger"),
    },
    {
      label: "Web App Text Larger",
      accelerator: "Alt+CmdOrCtrl+Plus",
      visible: false,
      click: textSizeClick("larger"),
    },
    {
      label: "Web App Text Smaller",
      accelerator: "Alt+CmdOrCtrl+-",
      click: textSizeClick("smaller"),
    },
    {
      label: "Web App Text Matches T3",
      accelerator: "Alt+CmdOrCtrl+0",
      click: textSizeClick("reset"),
    },
  ];
  return { viewItems };
});
