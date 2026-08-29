import type {
  DesktopSurface,
  RemoteAppState,
  RemoteAppSurfaceMenuAnchor,
  RemoteAppTheme,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import { getDesktopOrigin } from "../electron/ElectronProtocol.ts";
import {
  REMOTE_APP_ENTRY_URL,
  classifyRemoteAppNavigation,
  isAllowedPermission,
  isTrustedRemoteUrl,
  sanitizePersistedUrl,
  sanitizeRemoteTitle,
} from "./RemoteAppPolicy.ts";
import * as RemoteAppSession from "./RemoteAppSession.ts";
import * as RemoteAppStateStore from "./RemoteAppStateStore.ts";
import {
  buildRemoteAppThemeCss,
  buildRemoteAppInteractionScript,
  buildRemoteAppSurfaceMenuHtml,
  DEFAULT_REMOTE_APP_THEME,
  isChatGptRemoteAppUrl,
} from "./RemoteAppTheme.ts";
import { REMOTE_APP_STATE_CHANGE_CHANNEL } from "../ipc/channels.ts";
import { TITLEBAR_HEIGHT } from "./RemoteAppTypes.ts";

const REMOTE_APP_MAX_AUTOMATIC_RECOVERIES = 1;
const REMOTE_APP_VIEW_LAYER_INDEX = 0;
// SidebarChromeFooter is a 32px utility row with 8px padding on each side.
// Keep the live remote document above the host footer's exact 48px strip so
// the native Settings, Pull Requests, Usage, and update controls remain both
// visible and interactive on the ChatGPT surface.
export const REMOTE_APP_HOST_FOOTER_HEIGHT = 48;
export const REMOTE_APP_THEME_DOCUMENT_EVENTS = ["did-finish-load"] as const;

const addRemoteAppViewBelowHostRenderer = (
  window: Electron.BrowserWindow,
  view: Electron.WebContentsView,
) => {
  // The host renderer is already a child of contentView. Insert the remote
  // view first so the host remains above it wherever their bounds overlap.
  window.contentView.addChildView(view, REMOTE_APP_VIEW_LAYER_INDEX);
};

export const resolveRemoteAppZoomFactor = (current: number, delta: number | null): number =>
  delta === null ? 1 : Math.min(3, Math.max(0.5, current + delta));

export const resolveRemoteAppViewZoomFactor = (mainZoomFactor: number): number =>
  Number.isFinite(mainZoomFactor) && mainZoomFactor > 0 ? mainZoomFactor : 1;

export const resolveRemoteAppViewBounds = (
  contentBounds: Pick<Electron.Rectangle, "width" | "height">,
  mainZoomFactor: number,
): Electron.Rectangle => {
  const normalizedZoomFactor = resolveRemoteAppViewZoomFactor(mainZoomFactor);
  const titlebarHeight = Math.round(TITLEBAR_HEIGHT * normalizedZoomFactor);
  const hostFooterHeight = Math.round(REMOTE_APP_HOST_FOOTER_HEIGHT * normalizedZoomFactor);
  return {
    x: 0,
    y: titlebarHeight,
    width: Math.max(0, contentBounds.width),
    height: Math.max(0, contentBounds.height - titlebarHeight - hostFooterHeight),
  };
};

export const shouldAutomaticallyRecoverRenderer = (completedRecoveries: number): boolean =>
  completedRecoveries < REMOTE_APP_MAX_AUTOMATIC_RECOVERIES;

export const parseRemoteAppSurfaceMenuUrl = (url: string): DesktopSurface | undefined => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "t3code-surface:" || parsed.hostname !== "select") return undefined;
    if (parsed.pathname === "/t3code") return "t3code";
    if (parsed.pathname === "/chatgpt") return "chatgpt";
    return undefined;
  } catch {
    return undefined;
  }
};

export class RemoteAppManagerError extends Schema.TaggedErrorClass<RemoteAppManagerError>()(
  "RemoteAppManagerError",
  {
    operation: Schema.Literals([
      "attach",
      "create-view",
      "load",
      "layout",
      "clear-data",
      "state",
      "theme",
      "surface-menu",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The isolated ChatGPT surface failed during ${this.operation}.`;
  }
}

const isRemoteAppManagerError = Schema.is(RemoteAppManagerError);

export class RemoteAppManager extends Context.Service<
  RemoteAppManager,
  {
    readonly attachMainWindow: (
      window: Electron.BrowserWindow,
    ) => Effect.Effect<void, RemoteAppManagerError>;
    readonly getState: Effect.Effect<RemoteAppState>;
    readonly setTheme: (theme: RemoteAppTheme) => Effect.Effect<void, RemoteAppManagerError>;
    readonly openSurfaceMenu: (
      anchor: RemoteAppSurfaceMenuAnchor,
    ) => Effect.Effect<void, RemoteAppManagerError>;
    readonly syncLayout: Effect.Effect<void, RemoteAppManagerError>;
    readonly setActiveSurface: (
      surface: DesktopSurface,
    ) => Effect.Effect<RemoteAppState, RemoteAppManagerError>;
    readonly goBack: Effect.Effect<RemoteAppState>;
    readonly goForward: Effect.Effect<RemoteAppState>;
    readonly reload: Effect.Effect<RemoteAppState, RemoteAppManagerError>;
    readonly zoomIn: Effect.Effect<RemoteAppState, RemoteAppManagerError>;
    readonly zoomOut: Effect.Effect<RemoteAppState, RemoteAppManagerError>;
    readonly resetZoom: Effect.Effect<RemoteAppState, RemoteAppManagerError>;
    readonly retry: Effect.Effect<RemoteAppState, RemoteAppManagerError>;
    readonly clearData: Effect.Effect<RemoteAppState, RemoteAppManagerError>;
    readonly authorizeSender: (event: DesktopIpc.DesktopIpcInvokeEvent) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/remote-apps/RemoteAppManager") {}

const safeFilename = (filename: string): string => {
  const normalized = [...filename]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? "-" : character;
    })
    .join("")
    .replace(/[\\/:*?"<>|]/g, "-")
    .trim();
  return normalized.length > 0 ? normalized.slice(0, 180) : "ChatGPT download";
};

const isTrustedMainFrame = (webContents: Electron.WebContents): boolean =>
  isTrustedRemoteUrl(webContents.getURL());

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const shell = yield* ElectronShell.ElectronShell;
  const sessionService = yield* RemoteAppSession.RemoteAppSession;
  const stateStore = yield* RemoteAppStateStore.RemoteAppStateStore;
  const mainWindowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  const viewRef = yield* Ref.make<Option.Option<Electron.WebContentsView>>(Option.none());
  const attachedRef = yield* Ref.make(false);
  const recoveryCountRef = yield* Ref.make(0);
  const stateChangeLock = yield* Semaphore.make(1);
  const themeCssLock = yield* Semaphore.make(1);
  const remoteThemeRef = yield* Ref.make<RemoteAppTheme>(DEFAULT_REMOTE_APP_THEME);
  const insertedThemeKeyRef = yield* Ref.make<Option.Option<string>>(Option.none());
  const popupWindows = new Set<Electron.BrowserWindow>();
  let surfaceMenuWindow: Electron.BrowserWindow | null = null;

  const closeSurfaceMenu = (): void => {
    const menu = surfaceMenuWindow;
    surfaceMenuWindow = null;
    if (menu !== null && !menu.isDestroyed()) menu.close();
  };

  const runSafely = <A, E>(effect: Effect.Effect<A, E>): void => {
    void Effect.runPromise(
      effect.pipe(
        Effect.asVoid,
        Effect.catch(() => Effect.void),
      ),
    ).catch(() => undefined);
  };

  const getLiveWindow = Effect.gen(function* () {
    const window = yield* Ref.get(mainWindowRef);
    if (Option.isSome(window) && !window.value.isDestroyed()) return window;
    const fallback = Electron.BrowserWindow.getAllWindows().find(
      (candidate) => !candidate.isDestroyed(),
    );
    return Option.fromNullishOr(fallback ?? null);
  });

  const getLiveView = Effect.gen(function* () {
    const view = yield* Ref.get(viewRef);
    if (Option.isNone(view) || view.value.webContents.isDestroyed())
      return Option.none<Electron.WebContentsView>();
    return view;
  });

  const publish = (state: RemoteAppState): Effect.Effect<void> =>
    getLiveWindow.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (window) =>
            Effect.sync(() => {
              if (!window.webContents.isDestroyed()) {
                window.webContents.send(REMOTE_APP_STATE_CHANGE_CHANNEL, state);
              }
            }),
        }),
      ),
    );

  const updateState = (
    update: (state: RemoteAppState) => RemoteAppState,
  ): Effect.Effect<RemoteAppState, RemoteAppManagerError> =>
    stateChangeLock.withPermit(
      stateStore.update(update).pipe(
        Effect.tap(publish),
        Effect.mapError((cause) => new RemoteAppManagerError({ operation: "state", cause })),
      ),
    );
  const resetState = (): Effect.Effect<RemoteAppState, RemoteAppManagerError> =>
    stateChangeLock.withPermit(
      stateStore.get.pipe(
        Effect.flatMap((state) => stateStore.reset(state.activeSurface)),
        Effect.tap(publish),
        Effect.mapError((cause) => new RemoteAppManagerError({ operation: "state", cause })),
      ),
    );

  const updateNavigationState = (view: Electron.WebContentsView, state: RemoteAppState) => {
    const rawUrl = view.webContents.getURL();
    const safeUrl = sanitizePersistedUrl(rawUrl);
    const title = sanitizeRemoteTitle(view.webContents.getTitle());
    const recents =
      safeUrl === null
        ? state.recents
        : [
            { url: safeUrl, title },
            ...state.recents.filter((recent) => recent.url !== safeUrl),
          ].slice(0, 20);
    return {
      ...state,
      currentUrl: safeUrl ?? state.currentUrl,
      currentTitle: title || state.currentTitle,
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward(),
      recents,
      error: null,
    } satisfies RemoteAppState;
  };

  const syncNavigation = (view: Electron.WebContentsView) =>
    updateState((current) => updateNavigationState(view, current)).pipe(Effect.asVoid);

  const setLoadingState = (loadState: RemoteAppState["loadState"]) =>
    updateState((current) => ({ ...current, loadState, error: null })).pipe(Effect.asVoid);

  const positionView = (window: Electron.BrowserWindow, view: Electron.WebContentsView) =>
    Effect.try({
      try: () => {
        const bounds = window.getContentBounds();
        const zoomFactor = resolveRemoteAppViewZoomFactor(window.webContents.getZoomFactor());
        // The native shell owns application zoom. Keep the live remote page on
        // that same scale so its sidebar width, typography, and responsive
        // breakpoints continue to line up with the host at every zoom level.
        view.webContents.setZoomFactor(zoomFactor);
        view.setBounds(resolveRemoteAppViewBounds(bounds, zoomFactor));
      },
      catch: (cause) => new RemoteAppManagerError({ operation: "layout", cause }),
    });

  const openExternal = (url: string) => runSafely(shell.openExternal(url));

  const applyRemoteTheme = Effect.fn("remote-app.applyTheme")(function* (
    view: Electron.WebContentsView,
  ): Effect.fn.Return<void, RemoteAppManagerError> {
    yield* themeCssLock.withPermit(
      Effect.gen(function* () {
        const previousKey = yield* Ref.getAndSet(insertedThemeKeyRef, Option.none());
        if (Option.isSome(previousKey)) {
          yield* Effect.tryPromise({
            try: () => view.webContents.removeInsertedCSS(previousKey.value),
            catch: (cause) => new RemoteAppManagerError({ operation: "theme", cause }),
          }).pipe(Effect.catch(() => Effect.void));
        }
        if (!isChatGptRemoteAppUrl(view.webContents.getURL())) return;
        const theme = yield* Ref.get(remoteThemeRef);
        const key = yield* Effect.tryPromise({
          try: () => view.webContents.insertCSS(buildRemoteAppThemeCss(theme)),
          catch: (cause) => new RemoteAppManagerError({ operation: "theme", cause }),
        });
        yield* Ref.set(insertedThemeKeyRef, Option.some(key));
        yield* Effect.tryPromise({
          try: () => view.webContents.executeJavaScript(buildRemoteAppInteractionScript(theme)),
          catch: (cause) => new RemoteAppManagerError({ operation: "theme", cause }),
        }).pipe(Effect.catch(() => Effect.void));
      }),
    );
  });

  const configureView = (window: Electron.BrowserWindow, view: Electron.WebContentsView) => {
    const contents = view.webContents;
    contents.on("input-event", (_event, input) => {
      if (input.type === "mouseDown") contents.focus();
    });
    contents.setWindowOpenHandler(({ url }) => {
      const decision = classifyRemoteAppNavigation(url, { authFlowActive: true });
      if (decision.kind === "external") {
        openExternal(decision.url);
        return { action: "deny" };
      }
      if (decision.kind === "auth") {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            parent: window,
            modal: false,
            webPreferences: {
              partition: sessionService.partition,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              nodeIntegrationInSubFrames: false,
              webSecurity: true,
              allowRunningInsecureContent: false,
              devTools: environment.isDevelopment,
            },
          },
        };
      }
      if (decision.kind === "embed") {
        void contents.loadURL(decision.url).catch(() => undefined);
      }
      return { action: "deny" };
    });

    contents.on("will-navigate", (event, url) => {
      const decision = classifyRemoteAppNavigation(url);
      if (decision.kind !== "embed") {
        event.preventDefault();
        if (decision.kind === "external") openExternal(decision.url);
      }
    });
    contents.on("did-start-loading", () => runSafely(setLoadingState("loading")));
    for (const event of REMOTE_APP_THEME_DOCUMENT_EVENTS) {
      contents.on(event, () => runSafely(applyRemoteTheme(view)));
    }
    contents.on("did-stop-loading", () =>
      runSafely(syncNavigation(view).pipe(Effect.andThen(setLoadingState("ready")))),
    );
    contents.on("did-navigate", () => runSafely(syncNavigation(view)));
    contents.on("did-navigate-in-page", () => runSafely(syncNavigation(view)));
    contents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      runSafely(updateState((state) => ({ ...state, currentTitle: sanitizeRemoteTitle(title) })));
    });
    contents.on(
      "did-fail-load",
      (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        runSafely(
          updateState((state) => ({
            ...state,
            loadState: "failed",
            error: { category: "network", code: "load-failed" },
          })),
        );
      },
    );
    contents.on("render-process-gone", () => {
      runSafely(
        Effect.gen(function* () {
          const recoveryCount = yield* Ref.get(recoveryCountRef);
          if (shouldAutomaticallyRecoverRenderer(recoveryCount)) {
            yield* Ref.update(recoveryCountRef, (count) => count + 1);
            const next = yield* updateState((state) => ({
              ...state,
              loadState: "recovering",
              error: null,
            }));
            yield* Effect.tryPromise({
              try: () => contents.loadURL(next.currentUrl ?? REMOTE_APP_ENTRY_URL),
              catch: () => undefined,
            });
          } else {
            yield* updateState((state) => ({
              ...state,
              loadState: "crashed",
              error: { category: "renderer", code: "render-process-gone" },
            }));
          }
        }),
      );
    });
    contents.on("destroyed", () => {
      runSafely(
        Effect.gen(function* () {
          yield* Ref.set(viewRef, Option.none());
          yield* updateState((state) => ({
            ...state,
            loadState: "crashed",
            error: { category: "renderer", code: "destroyed" },
          }));
        }),
      );
    });
    contents.on("context-menu", (event) => event.preventDefault());
    contents.on("did-create-window", (childWindow, details) => {
      const decision = classifyRemoteAppNavigation(details.url, { authFlowActive: true });
      if (decision.kind !== "auth") {
        if (!childWindow.isDestroyed()) childWindow.close();
        return;
      }
      popupWindows.add(childWindow);
      childWindow.on("closed", () => popupWindows.delete(childWindow));
      childWindow.webContents.on("will-navigate", (event, url) => {
        const childDecision = classifyRemoteAppNavigation(url, { authFlowActive: true });
        if (childDecision.kind === "auth" || childDecision.kind === "embed") return;
        event.preventDefault();
        if (childDecision.kind === "external") openExternal(childDecision.url);
      });
      childWindow.webContents.setWindowOpenHandler(({ url }) => {
        const childDecision = classifyRemoteAppNavigation(url, { authFlowActive: true });
        if (childDecision.kind === "external") {
          openExternal(childDecision.url);
        }
        return { action: "deny" };
      });
    });
  };

  const configureSession = (
    session: Electron.Session,
    view: Electron.WebContentsView,
    owner: Electron.BrowserWindow,
  ) => {
    session.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(
        webContents === view.webContents &&
          isTrustedMainFrame(webContents) &&
          isAllowedPermission(permission, true),
      );
    });
    session.setPermissionCheckHandler(
      (webContents, permission) =>
        webContents === view.webContents &&
        isTrustedMainFrame(webContents) &&
        isAllowedPermission(permission, true),
    );
    session.on("will-download", (event, item) => {
      void event;
      if (!isTrustedRemoteUrl(item.getURL())) {
        item.cancel();
        return;
      }
      item.pause();
      void Electron.dialog
        .showSaveDialog(owner, { defaultPath: safeFilename(item.getFilename()) })
        .then((result) => {
          if (result.canceled || result.filePath === undefined) {
            item.cancel();
          } else {
            item.setSavePath(result.filePath);
            item.resume();
          }
        })
        .catch(() => item.cancel());
    });
  };

  const createView = Effect.fn("remote-app.createView")(function* (
    window: Electron.BrowserWindow,
  ): Effect.fn.Return<Electron.WebContentsView, RemoteAppManagerError> {
    const session = yield* sessionService.get.pipe(
      Effect.mapError((cause) => new RemoteAppManagerError({ operation: "create-view", cause })),
    );
    const view = yield* Effect.try({
      try: () =>
        new Electron.WebContentsView({
          webPreferences: {
            partition: sessionService.partition,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            experimentalFeatures: false,
            spellcheck: true,
            backgroundThrottling: true,
            devTools: environment.isDevelopment,
          },
        }),
      catch: (cause) => new RemoteAppManagerError({ operation: "create-view", cause }),
    });
    // Keep the live remote page beneath the host renderer. The renderer owns
    // the shared title bar and the native sidebar footer; when the ChatGPT
    // surface is active it makes only those host regions opaque/interactive.
    addRemoteAppViewBelowHostRenderer(window, view);
    configureView(window, view);
    configureSession(session, view, window);
    yield* positionView(window, view);
    view.setVisible(false);
    yield* Ref.set(viewRef, Option.some(view));
    return view;
  });

  const ensureView = Effect.fn("remote-app.ensureView")(function* (): Effect.fn.Return<
    Electron.WebContentsView,
    RemoteAppManagerError
  > {
    const window = yield* getLiveWindow.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new RemoteAppManagerError({ operation: "attach", cause: "main window unavailable" }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    yield* attachMainWindow(window);
    const existing = yield* getLiveView;
    if (Option.isSome(existing)) {
      yield* positionView(window, existing.value);
      return existing.value;
    }
    return yield* createView(window);
  });

  const showSurface = (surface: DesktopSurface) =>
    Effect.gen(function* () {
      closeSurfaceMenu();
      const window = yield* getLiveWindow;
      const view = yield* getLiveView;
      if (Option.isSome(view) && Option.isSome(window)) {
        if (surface === "chatgpt") {
          // Reattach before making it visible while preserving the host shell
          // above the remote page.
          window.value.contentView.removeChildView(view.value);
          addRemoteAppViewBelowHostRenderer(window.value, view.value);
          yield* positionView(window.value, view.value);
          view.value.setVisible(true);
          view.value.webContents.focus();
        } else {
          view.value.setVisible(false);
          // Remove the hidden child so the host renderer owns the surface and
          // the next ChatGPT activation can reinsert a clean topmost layer.
          window.value.contentView.removeChildView(view.value);
          window.value.webContents.focus();
        }
      }
    });

  const syncLayout = Effect.gen(function* () {
    const state = yield* stateStore.get;
    if (state.activeSurface === "chatgpt") {
      // Startup can finish adding the host renderer after the remote view was
      // created. Reconcile visibility and z-order from the current persisted
      // intent without changing that intent; a user switch made during boot
      // must not be overwritten by a late startup reassertion.
      yield* ensureView();
    }
    yield* showSurface(state.activeSurface);
    const window = yield* getLiveWindow;
    const view = yield* getLiveView;
    if (Option.isSome(window) && Option.isSome(view)) {
      yield* positionView(window.value, view.value);
    }
  });

  const attachMainWindow = Effect.fn("remote-app.attachMainWindow")(function* (
    window: Electron.BrowserWindow,
  ): Effect.fn.Return<void, RemoteAppManagerError> {
    const alreadyAttached = yield* Ref.get(attachedRef);
    if (alreadyAttached) return;
    yield* Ref.set(mainWindowRef, Option.some(window));
    yield* Ref.set(attachedRef, true);
    const reposition = () => {
      runSafely(
        Effect.gen(function* () {
          const view = yield* getLiveView;
          if (Option.isSome(view)) yield* positionView(window, view.value);
        }),
      );
    };
    const repositionAfterFullscreenTransition = () => {
      reposition();
      runSafely(Effect.sleep("100 millis").pipe(Effect.andThen(Effect.sync(reposition))));
    };
    for (const event of ["resize", "maximize", "unmaximize"] as const) {
      window.on(event as any, reposition);
    }
    window.on("enter-full-screen", repositionAfterFullscreenTransition);
    window.on("leave-full-screen", repositionAfterFullscreenTransition);
    window.on("closed", () => {
      closeSurfaceMenu();
      for (const popup of popupWindows) {
        if (!popup.isDestroyed()) popup.close();
      }
      popupWindows.clear();
      runSafely(
        Effect.gen(function* () {
          const view = yield* Ref.get(viewRef);
          if (Option.isSome(view)) {
            view.value.webContents.close();
            yield* Ref.set(viewRef, Option.none());
          }
          yield* Ref.set(mainWindowRef, Option.none());
        }),
      );
    });
  });

  const getState = stateStore.get;
  const setTheme = (theme: RemoteAppTheme) =>
    Effect.gen(function* () {
      yield* Ref.set(remoteThemeRef, theme);
      const view = yield* getLiveView;
      if (Option.isSome(view)) yield* applyRemoteTheme(view.value);
    }).pipe(
      Effect.mapError((cause) =>
        isRemoteAppManagerError(cause)
          ? cause
          : new RemoteAppManagerError({ operation: "theme", cause }),
      ),
    );
  const openSurfaceMenu = Effect.fn("remote-app.openSurfaceMenu")(function* (
    anchor: RemoteAppSurfaceMenuAnchor,
  ): Effect.fn.Return<void, RemoteAppManagerError> {
    const owner = yield* getLiveWindow.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new RemoteAppManagerError({
                operation: "surface-menu",
                cause: "main window unavailable",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    const state = yield* stateStore.get;
    const theme = yield* Ref.get(remoteThemeRef);
    closeSurfaceMenu();

    const menu = yield* Effect.try({
      try: () =>
        new Electron.BrowserWindow({
          parent: owner,
          modal: false,
          frame: false,
          transparent: true,
          resizable: false,
          movable: false,
          focusable: true,
          skipTaskbar: true,
          hasShadow: true,
          show: false,
          backgroundColor: "#00000000",
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            webSecurity: true,
            backgroundThrottling: true,
          },
        }),
      catch: (cause) => new RemoteAppManagerError({ operation: "surface-menu", cause }),
    });
    surfaceMenuWindow = menu;
    menu.setMenuBarVisibility(false);
    menu.setAlwaysOnTop(true);
    menu.setWindowButtonVisibility(false);
    menu.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    menu.webContents.on("will-navigate", (event, url) => {
      const surface = parseRemoteAppSurfaceMenuUrl(url);
      event.preventDefault();
      if (surface === undefined) return;
      closeSurfaceMenu();
      runSafely(setActiveSurface(surface));
    });
    menu.on("blur", closeSurfaceMenu);
    menu.on("closed", () => {
      if (surfaceMenuWindow === menu) surfaceMenuWindow = null;
    });

    const zoomFactor = owner.webContents.getZoomFactor();
    const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
    const contentBounds = owner.getContentBounds();
    const menuWidth = 196;
    const menuHeight = 92;
    const requestedX = contentBounds.x + Math.round(anchor.x * scale);
    const requestedY = contentBounds.y + Math.round((anchor.y + anchor.height) * scale) + 4;
    const display = Electron.screen.getDisplayNearestPoint({ x: requestedX, y: requestedY });
    const workArea = display.workArea;
    const x = Math.min(
      Math.max(workArea.x + 8, requestedX),
      workArea.x + workArea.width - menuWidth - 8,
    );
    const y = Math.min(
      Math.max(workArea.y + 8, requestedY),
      workArea.y + workArea.height - menuHeight - 8,
    );
    menu.setBounds({ x, y, width: menuWidth, height: menuHeight });
    const documentUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
      buildRemoteAppSurfaceMenuHtml(theme, state.activeSurface),
    )}`;
    yield* Effect.tryPromise({
      try: () => menu.loadURL(documentUrl),
      catch: (cause) => new RemoteAppManagerError({ operation: "surface-menu", cause }),
    }).pipe(Effect.tapError(() => Effect.sync(closeSurfaceMenu)));
    if (!menu.isDestroyed()) {
      menu.show();
      menu.focus();
    }
  });
  const setActiveSurface = (surface: DesktopSurface) =>
    Effect.gen(function* () {
      if (surface === "chatgpt") {
        const view = yield* ensureView();
        yield* showSurface(surface);
        if (view.webContents.getURL().length === 0) {
          const next = yield* updateState((state) => ({
            ...state,
            activeSurface: surface,
            loadState: "loading",
            error: null,
          }));
          yield* Effect.tryPromise({
            try: () => view.webContents.loadURL(next.currentUrl ?? REMOTE_APP_ENTRY_URL),
            catch: (cause) => new RemoteAppManagerError({ operation: "load", cause }),
          });
        } else {
          yield* updateState((state) => ({ ...state, activeSurface: surface }));
        }
      } else {
        yield* showSurface(surface);
        yield* updateState((state) => ({ ...state, activeSurface: surface }));
      }
      return yield* stateStore.get;
    });

  const viewNavigation = (operation: (contents: Electron.WebContents) => void) =>
    Effect.gen(function* () {
      const view = yield* getLiveView;
      if (Option.isSome(view) && (yield* stateStore.get).activeSurface === "chatgpt")
        operation(view.value.webContents);
      return yield* stateStore.get;
    });

  const reload = viewNavigation((contents) => contents.reload());
  const retry = Effect.gen(function* () {
    const view = yield* ensureView();
    const next = yield* updateState((current) => ({
      ...current,
      activeSurface: "chatgpt",
      loadState: "loading",
      error: null,
    }));
    yield* showSurface("chatgpt");
    yield* Effect.tryPromise({
      try: () => view.webContents.loadURL(next.currentUrl ?? REMOTE_APP_ENTRY_URL),
      catch: (cause) => new RemoteAppManagerError({ operation: "load", cause }),
    });
    return yield* stateStore.get;
  });

  const zoom = (delta: number | null) =>
    Effect.gen(function* () {
      const view = yield* getLiveView;
      const state = yield* stateStore.get;
      if (Option.isNone(view)) return state;
      const nextZoom = resolveRemoteAppZoomFactor(state.zoomFactor, delta);
      view.value.webContents.setZoomFactor(nextZoom);
      return yield* updateState((current) => ({ ...current, zoomFactor: nextZoom }));
    });

  const clearData = Effect.gen(function* () {
    const state = yield* stateStore.get;
    yield* updateState((current) => ({ ...current, loadState: "clearing", error: null }));
    yield* sessionService.clearData.pipe(
      Effect.mapError((cause) => new RemoteAppManagerError({ operation: "clear-data", cause })),
    );
    const reset = yield* resetState().pipe(
      Effect.mapError(
        (error) => new RemoteAppManagerError({ operation: "clear-data", cause: error }),
      ),
    );
    yield* Ref.set(recoveryCountRef, 0);
    const view = yield* getLiveView;
    if (Option.isSome(view) && state.activeSurface === "chatgpt") {
      yield* Effect.tryPromise({
        try: () => view.value.webContents.loadURL(REMOTE_APP_ENTRY_URL),
        catch: (cause) => new RemoteAppManagerError({ operation: "load", cause }),
      });
    }
    return reset;
  });

  return RemoteAppManager.of({
    attachMainWindow,
    getState,
    setTheme,
    openSurfaceMenu,
    syncLayout,
    setActiveSurface,
    goBack: viewNavigation((contents) => contents.canGoBack() && contents.goBack()),
    goForward: viewNavigation((contents) => contents.canGoForward() && contents.goForward()),
    reload,
    zoomIn: zoom(0.1),
    zoomOut: zoom(-0.1),
    resetZoom: zoom(null),
    retry,
    clearData,
    authorizeSender: (event) => {
      const senderId = event.sender?.id;
      const senderUrl = (() => {
        try {
          return event.sender?.getURL?.();
        } catch {
          return undefined;
        }
      })();
      const trustedRenderer = (() => {
        if (senderUrl === undefined) return false;
        const origin = getDesktopOrigin(environment.isDevelopment);
        return senderUrl === `${origin}/` || senderUrl.startsWith(`${origin}/`);
      })();
      return getLiveWindow.pipe(
        Effect.map(
          (window) =>
            trustedRenderer &&
            senderId !== undefined &&
            Option.isSome(window) &&
            !window.value.isDestroyed() &&
            window.value.webContents.id === senderId,
        ),
      );
    },
  });
});

export const layer = Layer.effect(RemoteAppManager, make);
