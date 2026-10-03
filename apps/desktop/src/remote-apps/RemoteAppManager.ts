import {
  isRemoteAppSite,
  REMOTE_APP_SITE_LABELS,
  REMOTE_APP_SITES,
  type DesktopSurface,
  type RemoteAppSite,
  type RemoteAppState,
  type RemoteAppSurfaceMenuAnchor,
  type RemoteAppTheme,
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
  REMOTE_APP_SITE_DEFINITIONS,
  canUseRemoteAppControl,
  classifyRemoteAppNavigation,
  isAllowedPermission,
  isTrustedRemoteUrl,
  resolveRemoteAppSiteForUrl,
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
  REMOTE_APP_SURFACE_MENU_WIDTH,
  resolveRemoteAppSurfaceMenuHeight,
} from "./RemoteAppTheme.ts";
import { REMOTE_APP_STATE_CHANGE_CHANNEL } from "../ipc/channels.ts";
import { TITLEBAR_HEIGHT } from "./RemoteAppTypes.ts";

const REMOTE_APP_MAX_AUTOMATIC_RECOVERIES = 1;
const REMOTE_APP_VIEW_LAYER_INDEX = 0;
// SidebarChromeFooter is a 32px utility row with 8px padding on each side.
// Keep the live remote document above the host footer's exact 48px strip so
// the native Settings, Pull Requests, Usage, and update controls remain both
// visible and interactive on a remote surface.
export const REMOTE_APP_HOST_FOOTER_HEIGHT = 48;
export const REMOTE_APP_THEME_DOCUMENT_EVENTS = ["did-finish-load"] as const;
export const REMOTE_APP_THEME_NAVIGATION_EVENTS = ["did-navigate-in-page"] as const;

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
    const surface = parsed.pathname.slice(1);
    if (surface === "t3code") return "t3code";
    return isRemoteAppSite(surface) ? surface : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The menu lists T3 plus every available site in a stable order. The active
 * site stays listed after its provider signs out so the current choice is
 * always visible.
 */
export const resolveRemoteAppMenuSurfaces = (
  availableSites: ReadonlyArray<RemoteAppSite>,
  activeSurface: DesktopSurface,
): ReadonlyArray<DesktopSurface> => [
  "t3code",
  ...REMOTE_APP_SITES.filter((site) => availableSites.includes(site) || site === activeSurface),
];

/** The URL to open for a site: its last persisted page when it belongs to that site. */
export const resolveRemoteAppSiteUrl = (site: RemoteAppSite, persistedUrl: string | null): string =>
  persistedUrl !== null && resolveRemoteAppSiteForUrl(persistedUrl) === site
    ? persistedUrl
    : REMOTE_APP_SITE_DEFINITIONS[site].entryUrl;

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
    return `The isolated remote app surface failed during ${this.operation}.`;
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
    readonly setAvailableSites: (sites: ReadonlyArray<RemoteAppSite>) => Effect.Effect<void>;
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
  return normalized.length > 0 ? normalized.slice(0, 180) : "download";
};

const activeSiteOf = (state: RemoteAppState): RemoteAppSite | undefined =>
  canUseRemoteAppControl(state.activeSurface) ? state.activeSurface : undefined;

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const shell = yield* ElectronShell.ElectronShell;
  const sessionService = yield* RemoteAppSession.RemoteAppSession;
  const stateStore = yield* RemoteAppStateStore.RemoteAppStateStore;
  const mainWindowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  const attachedRef = yield* Ref.make(false);
  const stateChangeLock = yield* Semaphore.make(1);
  const themeCssLock = yield* Semaphore.make(1);
  const remoteThemeRef = yield* Ref.make<RemoteAppTheme>(DEFAULT_REMOTE_APP_THEME);
  const availableSitesRef = yield* Ref.make<ReadonlyArray<RemoteAppSite>>([]);
  // Views are created on first activation and kept while hidden, so switching
  // sites is instant. Hidden views are detached and background-throttled.
  const views = new Map<RemoteAppSite, Electron.WebContentsView>();
  const recoveryCounts = new Map<RemoteAppSite, number>();
  const insertedThemeKeys = new Map<RemoteAppSite, string>();
  const sessionsWithDownloadHandler = new WeakSet<Electron.Session>();
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

  const getLiveView = (site: RemoteAppSite) =>
    Effect.sync(() => {
      const view = views.get(site);
      return view === undefined || view.webContents.isDestroyed()
        ? Option.none<Electron.WebContentsView>()
        : Option.some(view);
    });

  const closeView = (site: RemoteAppSite, window: Option.Option<Electron.BrowserWindow>) => {
    const view = views.get(site);
    views.delete(site);
    insertedThemeKeys.delete(site);
    recoveryCounts.delete(site);
    if (view === undefined) return;
    if (Option.isSome(window) && !window.value.isDestroyed()) {
      window.value.contentView.removeChildView(view);
    }
    if (!view.webContents.isDestroyed()) view.webContents.close();
  };

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

  /**
   * The persisted state describes the active site. Events from hidden views
   * are ignored here and reconciled when that site is activated again.
   */
  const updateSiteState = (
    site: RemoteAppSite,
    update: (state: RemoteAppState) => RemoteAppState,
  ): Effect.Effect<void, RemoteAppManagerError> =>
    Effect.gen(function* () {
      if (activeSiteOf(yield* stateStore.get) !== site) return;
      yield* updateState((state) => (activeSiteOf(state) === site ? update(state) : state));
    });

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

  const syncNavigation = (site: RemoteAppSite, view: Electron.WebContentsView) =>
    updateSiteState(site, (current) => updateNavigationState(view, current));

  const setLoadingState = (site: RemoteAppSite, loadState: RemoteAppState["loadState"]) =>
    updateSiteState(site, (current) => ({ ...current, loadState, error: null }));

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

  /**
   * Every site follows the app's light/dark choice through prefers-color-scheme,
   * which the host already drives via nativeTheme. ChatGPT additionally gets the
   * full T3 palette as a scoped user stylesheet.
   */
  const applyRemoteTheme = Effect.fn("remote-app.applyTheme")(function* (
    site: RemoteAppSite,
    view: Electron.WebContentsView,
  ): Effect.fn.Return<void, RemoteAppManagerError> {
    yield* themeCssLock.withPermit(
      Effect.gen(function* () {
        const theme = yield* Ref.get(remoteThemeRef);
        view.setBackgroundColor(theme.colors.canvas);
        const previousKey = insertedThemeKeys.get(site);
        insertedThemeKeys.delete(site);
        if (previousKey !== undefined) {
          yield* Effect.tryPromise({
            try: () => view.webContents.removeInsertedCSS(previousKey),
            catch: (cause) => new RemoteAppManagerError({ operation: "theme", cause }),
          }).pipe(Effect.catch(() => Effect.void));
        }
        if (site !== "chatgpt" || !isChatGptRemoteAppUrl(view.webContents.getURL())) return;
        const key = yield* Effect.tryPromise({
          try: () => view.webContents.insertCSS(buildRemoteAppThemeCss(theme)),
          catch: (cause) => new RemoteAppManagerError({ operation: "theme", cause }),
        });
        insertedThemeKeys.set(site, key);
        yield* Effect.tryPromise({
          try: () => view.webContents.executeJavaScript(buildRemoteAppInteractionScript(theme)),
          catch: (cause) => new RemoteAppManagerError({ operation: "theme", cause }),
        }).pipe(Effect.catch(() => Effect.void));
      }),
    );
  });

  const configureView = (
    site: RemoteAppSite,
    window: Electron.BrowserWindow,
    view: Electron.WebContentsView,
  ) => {
    const contents = view.webContents;
    contents.on("input-event", (_event, input) => {
      if (input.type === "mouseDown") contents.focus();
    });
    contents.setWindowOpenHandler(({ url }) => {
      const decision = classifyRemoteAppNavigation(site, url, { authFlowActive: true });
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
              partition: sessionService.partition(site),
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
      // A top-level redirect to the site's identity provider is its own
      // sign-in flow; let it finish in place.
      const decision = classifyRemoteAppNavigation(site, url, { authFlowActive: true });
      if (decision.kind !== "embed" && decision.kind !== "auth") {
        event.preventDefault();
        if (decision.kind === "external") openExternal(decision.url);
      }
    });
    contents.on("did-start-loading", () => runSafely(setLoadingState(site, "loading")));
    for (const event of REMOTE_APP_THEME_DOCUMENT_EVENTS) {
      contents.on(event, () => runSafely(applyRemoteTheme(site, view)));
    }
    contents.on("did-stop-loading", () =>
      runSafely(syncNavigation(site, view).pipe(Effect.andThen(setLoadingState(site, "ready")))),
    );
    contents.on("did-navigate", () => runSafely(syncNavigation(site, view)));
    for (const event of REMOTE_APP_THEME_NAVIGATION_EVENTS) {
      contents.on(event, () =>
        runSafely(syncNavigation(site, view).pipe(Effect.andThen(applyRemoteTheme(site, view)))),
      );
    }
    contents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      runSafely(
        updateSiteState(site, (state) => ({ ...state, currentTitle: sanitizeRemoteTitle(title) })),
      );
    });
    contents.on(
      "did-fail-load",
      (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        runSafely(
          updateSiteState(site, (state) => ({
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
          const recoveryCount = recoveryCounts.get(site) ?? 0;
          if (shouldAutomaticallyRecoverRenderer(recoveryCount)) {
            recoveryCounts.set(site, recoveryCount + 1);
            yield* updateSiteState(site, (state) => ({
              ...state,
              loadState: "recovering",
              error: null,
            }));
            const state = yield* stateStore.get;
            yield* Effect.tryPromise({
              try: () => contents.loadURL(resolveRemoteAppSiteUrl(site, state.currentUrl)),
              catch: () => undefined,
            });
          } else {
            yield* updateSiteState(site, (state) => ({
              ...state,
              loadState: "crashed",
              error: { category: "renderer", code: "render-process-gone" },
            }));
          }
        }),
      );
    });
    contents.on("destroyed", () => {
      if (views.get(site) === view) views.delete(site);
      runSafely(
        updateSiteState(site, (state) => ({
          ...state,
          loadState: "crashed",
          error: { category: "renderer", code: "destroyed" },
        })),
      );
    });
    contents.on("context-menu", (event) => event.preventDefault());
    contents.on("did-create-window", (childWindow, details) => {
      const decision = classifyRemoteAppNavigation(site, details.url, { authFlowActive: true });
      if (decision.kind !== "auth") {
        if (!childWindow.isDestroyed()) childWindow.close();
        return;
      }
      popupWindows.add(childWindow);
      childWindow.on("closed", () => popupWindows.delete(childWindow));
      childWindow.webContents.on("will-navigate", (event, url) => {
        const childDecision = classifyRemoteAppNavigation(site, url, { authFlowActive: true });
        if (childDecision.kind === "auth" || childDecision.kind === "embed") return;
        event.preventDefault();
        if (childDecision.kind === "external") openExternal(childDecision.url);
      });
      childWindow.webContents.setWindowOpenHandler(({ url }) => {
        const childDecision = classifyRemoteAppNavigation(site, url, { authFlowActive: true });
        if (childDecision.kind === "external") {
          openExternal(childDecision.url);
        }
        return { action: "deny" };
      });
    });
  };

  const configureSession = (
    site: RemoteAppSite,
    session: Electron.Session,
    view: Electron.WebContentsView,
    owner: Electron.BrowserWindow,
  ) => {
    const isTrustedMainFrame = (webContents: Electron.WebContents): boolean =>
      webContents === view.webContents && isTrustedRemoteUrl(site, webContents.getURL());
    // Handlers replace earlier ones, so a recreated view rebinds them.
    session.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(isTrustedMainFrame(webContents) && isAllowedPermission(permission, true));
    });
    session.setPermissionCheckHandler(
      (webContents, permission) =>
        webContents !== null &&
        isTrustedMainFrame(webContents) &&
        isAllowedPermission(permission, true),
    );
    // Listeners accumulate, so each session gets exactly one download handler.
    if (sessionsWithDownloadHandler.has(session)) return;
    sessionsWithDownloadHandler.add(session);
    session.on("will-download", (_event, item) => {
      if (!isTrustedRemoteUrl(site, item.getURL())) {
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
    site: RemoteAppSite,
    window: Electron.BrowserWindow,
  ): Effect.fn.Return<Electron.WebContentsView, RemoteAppManagerError> {
    const session = yield* sessionService
      .get(site)
      .pipe(
        Effect.mapError((cause) => new RemoteAppManagerError({ operation: "create-view", cause })),
      );
    const theme = yield* Ref.get(remoteThemeRef);
    const view = yield* Effect.try({
      try: () =>
        new Electron.WebContentsView({
          webPreferences: {
            partition: sessionService.partition(site),
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
    // Paint the T3 canvas behind the page so first load never flashes white.
    view.setBackgroundColor(theme.colors.canvas);
    configureView(site, window, view);
    configureSession(site, session, view, window);
    yield* positionView(window, view);
    view.setVisible(false);
    views.set(site, view);
    return view;
  });

  const requireLiveWindow = (operation: "attach" | "surface-menu") =>
    getLiveWindow.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new RemoteAppManagerError({ operation, cause: "main window unavailable" }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const ensureView = Effect.fn("remote-app.ensureView")(function* (
    site: RemoteAppSite,
  ): Effect.fn.Return<Electron.WebContentsView, RemoteAppManagerError> {
    const window = yield* requireLiveWindow("attach");
    yield* attachMainWindow(window);
    const existing = yield* getLiveView(site);
    if (Option.isSome(existing)) {
      yield* positionView(window, existing.value);
      return existing.value;
    }
    return yield* createView(site, window);
  });

  const showSurface = (surface: DesktopSurface) =>
    Effect.gen(function* () {
      closeSurfaceMenu();
      const window = yield* getLiveWindow;
      if (Option.isNone(window)) return;
      // Detach every other view so the host renderer owns the surface and the
      // next activation reinserts a clean layer beneath it.
      for (const [site, view] of views) {
        if (site === surface || view.webContents.isDestroyed()) continue;
        view.setVisible(false);
        window.value.contentView.removeChildView(view);
      }
      const view = canUseRemoteAppControl(surface)
        ? yield* getLiveView(surface)
        : Option.none<Electron.WebContentsView>();
      if (Option.isNone(view) || !canUseRemoteAppControl(surface)) {
        window.value.webContents.focus();
        return;
      }
      // Reattach before making it visible while preserving the host shell
      // above the remote page.
      window.value.contentView.removeChildView(view.value);
      addRemoteAppViewBelowHostRenderer(window.value, view.value);
      yield* positionView(window.value, view.value);
      view.value.setVisible(true);
      // Surface switches can happen while the renderer is still reconciling
      // its theme snapshot. Reapply the manager's current validated palette at
      // the activation boundary so a reused view cannot show the old theme.
      yield* applyRemoteTheme(surface, view.value);
      view.value.webContents.focus();
    });

  const syncLayout = Effect.gen(function* () {
    const state = yield* stateStore.get;
    const site = activeSiteOf(state);
    // Startup can finish adding the host renderer after the remote view was
    // created. Reconcile visibility and z-order from the current persisted
    // intent without changing that intent; a user switch made during boot
    // must not be overwritten by a late startup reassertion.
    if (site !== undefined) yield* ensureView(site);
    yield* showSurface(state.activeSurface);
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
          // Hidden views are repositioned when they are shown again.
          const site = activeSiteOf(yield* stateStore.get);
          if (site === undefined) return;
          const view = yield* getLiveView(site);
          if (Option.isSome(view)) yield* positionView(window, view.value);
        }),
      );
    };
    const repositionAfterFullscreenTransition = () => {
      reposition();
      runSafely(Effect.sleep("100 millis").pipe(Effect.andThen(Effect.sync(reposition))));
    };
    window.on("resize", reposition);
    window.on("maximize", reposition);
    window.on("unmaximize", reposition);
    window.on("enter-full-screen", repositionAfterFullscreenTransition);
    window.on("leave-full-screen", repositionAfterFullscreenTransition);
    window.on("closed", () => {
      closeSurfaceMenu();
      for (const popup of popupWindows) {
        if (!popup.isDestroyed()) popup.close();
      }
      popupWindows.clear();
      for (const site of [...views.keys()]) closeView(site, Option.none());
      runSafely(Ref.set(mainWindowRef, Option.none()));
    });
  });

  const getState = stateStore.get;
  const setTheme = (theme: RemoteAppTheme) =>
    Effect.gen(function* () {
      yield* Ref.set(remoteThemeRef, theme);
      for (const site of [...views.keys()]) {
        const view = yield* getLiveView(site);
        if (Option.isSome(view)) yield* applyRemoteTheme(site, view.value);
      }
    }).pipe(
      Effect.mapError((cause) =>
        isRemoteAppManagerError(cause)
          ? cause
          : new RemoteAppManagerError({ operation: "theme", cause }),
      ),
    );

  const setAvailableSites = (sites: ReadonlyArray<RemoteAppSite>) =>
    Effect.gen(function* () {
      yield* Ref.set(availableSitesRef, sites);
      // Release the memory of hidden sites whose provider was disabled or
      // signed out. The active site stays until the user switches away.
      const activeSite = activeSiteOf(yield* stateStore.get);
      const window = yield* getLiveWindow;
      for (const site of [...views.keys()]) {
        if (site !== activeSite && !sites.includes(site)) closeView(site, window);
      }
    });

  const openSurfaceMenu = Effect.fn("remote-app.openSurfaceMenu")(function* (
    anchor: RemoteAppSurfaceMenuAnchor,
  ): Effect.fn.Return<void, RemoteAppManagerError> {
    const owner = yield* requireLiveWindow("surface-menu");
    const state = yield* stateStore.get;
    const theme = yield* Ref.get(remoteThemeRef);
    const surfaces = resolveRemoteAppMenuSurfaces(
      yield* Ref.get(availableSitesRef),
      state.activeSurface,
    );
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
    const menuWidth = REMOTE_APP_SURFACE_MENU_WIDTH;
    const menuHeight = resolveRemoteAppSurfaceMenuHeight(surfaces.length);
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
      buildRemoteAppSurfaceMenuHtml(theme, state.activeSurface, surfaces),
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

  const loadUrl = (view: Electron.WebContentsView, url: string) =>
    Effect.tryPromise({
      try: () => view.webContents.loadURL(url),
      catch: (cause) => new RemoteAppManagerError({ operation: "load", cause }),
    });

  const activateSite = (site: RemoteAppSite) =>
    Effect.gen(function* () {
      const view = yield* ensureView(site);
      const previous = yield* stateStore.get;
      yield* showSurface(site);
      if (view.webContents.getURL().length === 0) {
        const url = resolveRemoteAppSiteUrl(site, previous.currentUrl);
        yield* updateState((state) => ({
          ...state,
          activeSurface: site,
          loadState: "loading",
          currentUrl: url,
          currentTitle: REMOTE_APP_SITE_LABELS[site],
          canGoBack: false,
          canGoForward: false,
          error: null,
        }));
        yield* loadUrl(view, url);
        return;
      }
      // A kept view already holds its page; describe it from the view itself.
      yield* updateState((state) => {
        const sameSite = state.activeSurface === site;
        return {
          ...updateNavigationState(view, {
            ...state,
            currentUrl: sameSite ? state.currentUrl : REMOTE_APP_SITE_DEFINITIONS[site].entryUrl,
            currentTitle: sameSite ? state.currentTitle : REMOTE_APP_SITE_LABELS[site],
          }),
          activeSurface: site,
          loadState: view.webContents.isLoading() ? "loading" : "ready",
        };
      });
    });

  const setActiveSurface = (surface: DesktopSurface) =>
    Effect.gen(function* () {
      if (canUseRemoteAppControl(surface)) {
        yield* activateSite(surface);
      } else {
        yield* showSurface(surface);
        yield* updateState((state) => ({ ...state, activeSurface: surface }));
      }
      return yield* stateStore.get;
    });

  const withActiveView = (
    operation: (site: RemoteAppSite, view: Electron.WebContentsView) => void,
  ) =>
    Effect.gen(function* () {
      const site = activeSiteOf(yield* stateStore.get);
      if (site !== undefined) {
        const view = yield* getLiveView(site);
        if (Option.isSome(view)) operation(site, view.value);
      }
      return yield* stateStore.get;
    });

  const reload = withActiveView((_site, view) => view.webContents.reload());
  const retry = Effect.gen(function* () {
    const state = yield* stateStore.get;
    const site = activeSiteOf(state);
    if (site === undefined) return state;
    const view = yield* ensureView(site);
    const next = yield* updateState((current) => ({
      ...current,
      loadState: "loading",
      error: null,
    }));
    yield* showSurface(site);
    yield* loadUrl(view, resolveRemoteAppSiteUrl(site, next.currentUrl));
    return yield* stateStore.get;
  });

  const zoom = (delta: number | null) =>
    Effect.gen(function* () {
      const state = yield* stateStore.get;
      const site = activeSiteOf(state);
      if (site === undefined) return state;
      const view = yield* getLiveView(site);
      if (Option.isNone(view)) return state;
      const nextZoom = resolveRemoteAppZoomFactor(state.zoomFactor, delta);
      view.value.webContents.setZoomFactor(nextZoom);
      return yield* updateState((current) => ({ ...current, zoomFactor: nextZoom }));
    });

  /** Signs the active site out by wiping only its own partition. */
  const clearData = Effect.gen(function* () {
    const state = yield* stateStore.get;
    const site = activeSiteOf(state);
    if (site === undefined) return state;
    yield* updateState((current) => ({ ...current, loadState: "clearing", error: null }));
    yield* sessionService
      .clearData(site)
      .pipe(
        Effect.mapError((cause) => new RemoteAppManagerError({ operation: "clear-data", cause })),
      );
    const entryUrl = REMOTE_APP_SITE_DEFINITIONS[site].entryUrl;
    const reset = yield* updateState((current) => ({
      ...RemoteAppStateStore.DEFAULT_REMOTE_APP_STATE,
      activeSurface: current.activeSurface,
      currentUrl: entryUrl,
      currentTitle: REMOTE_APP_SITE_LABELS[site],
      recents: current.recents.filter(
        (recent) => resolveRemoteAppSiteForUrl(recent.url) !== site,
      ),
    })).pipe(
      Effect.mapError(
        (error) => new RemoteAppManagerError({ operation: "clear-data", cause: error }),
      ),
    );
    recoveryCounts.delete(site);
    const view = yield* getLiveView(site);
    if (Option.isSome(view)) yield* loadUrl(view.value, entryUrl);
    return reset;
  });

  return RemoteAppManager.of({
    attachMainWindow,
    getState,
    setTheme,
    setAvailableSites,
    openSurfaceMenu,
    syncLayout,
    setActiveSurface,
    goBack: withActiveView(
      (_site, view) => view.webContents.canGoBack() && view.webContents.goBack(),
    ),
    goForward: withActiveView(
      (_site, view) => view.webContents.canGoForward() && view.webContents.goForward(),
    ),
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
