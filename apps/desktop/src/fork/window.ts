// Fork add-on: main window hooks for remote apps. DesktopWindow calls these at
// a few fixed points; everything is a no-op when RemoteAppManager is absent.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as RemoteAppManager from "../remote-apps/RemoteAppManager.ts";
import { guardRemoteAppWebview, isRemoteAppWebview } from "../remote-apps/RemoteAppWebview.ts";

const MAIN_WINDOW_REVEAL_FALLBACK_DELAY_MS = 5_000;

const { logWarning: logWindowWarning } = makeComponentLogger("desktop-window");

type RevealSubscription = (listener: () => void) => void;

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const remoteAppManager = yield* Effect.serviceOption(RemoteAppManager.RemoteAppManager);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const reassertSurface = () => {
    if (Option.isNone(remoteAppManager)) return;
    void runPromise(
      remoteAppManager.value.syncLayout.pipe(
        Effect.catchTag("RemoteAppManagerError", (error) =>
          logWindowWarning("failed to restore remote app surface after main renderer load", {
            error: error.message,
          }),
        ),
      ),
    ).catch(() => undefined);
  };

  /** Attaches the main window and restores the remote app surface that was active last. */
  const attach = Effect.fnUntraced(function* (window: Electron.BrowserWindow) {
    if (Option.isNone(remoteAppManager)) return;
    yield* remoteAppManager.value.attachMainWindow(window).pipe(
      Effect.catch((error) =>
        logWindowWarning("failed to attach remote app surface", {
          error: error.message,
        }),
      ),
    );
    const remoteAppState = yield* remoteAppManager.value.getState;
    if (remoteAppState.activeSurface !== "t3code") {
      yield* remoteAppManager.value.setActiveSurface(remoteAppState.activeSurface).pipe(
        Effect.catch((error) =>
          logWindowWarning("failed to restore remote app surface", {
            error: error.message,
          }),
        ),
      );
    }
  });

  /**
   * Extra first-reveal triggers. A WebContentsView attached during boot can
   * prevent macOS from emitting ready-to-show even though the host renderer
   * finished loading, so the window must never be left headless.
   */
  const revealSubscribers = (window: Electron.BrowserWindow): RevealSubscription[] => [
    // Upstream already subscribes to did-finish-load on Linux.
    ...(environment.platform === "linux"
      ? []
      : [(fire: () => void) => window.webContents.once("did-finish-load", fire)]),
    // If both lifecycle events are suppressed by a native child view, the
    // window is still safe to reveal after this bounded boot grace period.
    (fire) =>
      setTimeout(() => {
        if (!window.isDestroyed()) {
          window.show();
          if (environment.platform === "darwin") {
            Electron.app.focus({ steal: true });
          }
          window.focus();
        }
        fire();
      }, MAIN_WINDOW_REVEAL_FALLBACK_DELAY_MS),
  ];

  /** Runs the upstream reveal, then puts the active remote app surface back on top. */
  const afterReveal = <E1, R1, E2, R2>(
    reveal: Effect.Effect<unknown, E1, R1>,
    dismissSplash: Effect.Effect<unknown, E2, R2>,
  ) => Effect.andThen(reveal, Effect.andThen(dismissSplash, Effect.sync(reassertSurface)));

  /** Reflows the remote app surface after the app zoom changes. */
  const afterZoom = Option.isNone(remoteAppManager)
    ? Effect.void
    : remoteAppManager.value.syncLayout.pipe(
        Effect.catchTag("RemoteAppManagerError", (error) =>
          logWindowWarning("failed to reflow remote app surface after app zoom", {
            error: error.message,
          }),
        ),
      );

  /**
   * The `will-attach-webview` hook: true when the attach is a remote app's
   * side panel and has been hardened or rejected here. Without the manager
   * nothing adopts such a page, so the upstream gate rejects it.
   */
  const guardWebview = (
    event: Electron.Event,
    webPreferences: Electron.WebPreferences,
    params: Record<string, string>,
  ): boolean =>
    Option.isSome(remoteAppManager) &&
    guardRemoteAppWebview(event, webPreferences, params, environment.isDevelopment);

  return {
    attach,
    reassertSurface,
    revealSubscribers,
    afterReveal,
    afterZoom,
    guardWebview,
    isRemoteAppWebview,
  };
});
