import {
  isRemoteAppSite,
  REMOTE_APP_SITE_INFO,
  REMOTE_APP_SITES,
  REMOTE_APP_TRANSFER_TEXT_MAX_LENGTH,
  type DesktopSurface,
  type RemoteAppAvailability,
  type RemoteAppFillPromptRequest,
  type RemoteAppFillPromptResult,
  type RemoteAppSendToThread,
  type RemoteAppSite,
  type RemoteAppState,
  type RemoteAppSurfaceMenuAnchor,
  type RemoteAppTheme,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
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
  isTrustedRemoteHost,
  isTrustedRemoteUrl,
  resolveRemoteAppSiteForUrl,
  sanitizePersistedUrl,
  sanitizeRemoteTitle,
} from "./RemoteAppPolicy.ts";
import * as RemoteAppSession from "./RemoteAppSession.ts";
import * as RemoteAppStateStore from "./RemoteAppStateStore.ts";
import {
  buildRemoteAppSidebarWidthScript,
  buildRemoteSiteThemeCss,
  isThemeableRemoteAppSite,
} from "./RemoteAppSiteTheme.ts";
import {
  buildRemoteAppInteractionScript,
  buildRemoteAppSurfaceMenuHtml,
  DEFAULT_REMOTE_APP_THEME,
  isChatGptRemoteAppUrl,
  REMOTE_APP_SURFACE_MENU_WIDTH,
  resolveRemoteAppSurfaceMenuBackground,
  resolveRemoteAppSurfaceMenuHeight,
  type RemoteAppSurfaceMenuMaterial,
} from "./RemoteAppTheme.ts";
import { REMOTE_APP_STATE_CHANGE_CHANNEL } from "../ipc/channels.ts";
import { REMOTE_APP_SEND_TO_THREAD_CHANNEL } from "./RemoteAppChannels.ts";
import {
  buildRemoteAppActivityScript,
  buildRemoteAppNoticeScript,
  buildRemoteAppPromptFillScript,
  REMOTE_APP_PAGE_WORLD_ID,
} from "./RemoteAppPageScripts.ts";
import { REMOTE_APP_VIEW_TOP_INSET, TITLEBAR_HEIGHT } from "./RemoteAppTypes.ts";

const REMOTE_APP_MAX_AUTOMATIC_RECOVERIES = 1;
const REMOTE_APP_VIEW_LAYER_INDEX = 0;
// Background preload pacing. The first site waits until T3 has painted and
// settled; each later one waits for the previous page to load and hydrate, so
// at most one site is loading at a time.
const REMOTE_APP_PRELOAD_START_DELAY_MS = 4_000;
const REMOTE_APP_PRELOAD_RESCHEDULE_DELAY_MS = 1_000;
const REMOTE_APP_PRELOAD_LOAD_TIMEOUT = "20 seconds";
const REMOTE_APP_PRELOAD_SETTLE_DELAY = "2 seconds";
// The idle unload sweep is coarse: a hidden site goes up to this long past its
// limit before it is released.
const REMOTE_APP_IDLE_SWEEP_INTERVAL = "5 minutes";
// How long a prompt fill waits for a site that is still loading.
const REMOTE_APP_FILL_LOAD_TIMEOUT = "15 seconds";
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
  hostFooterVisible = true,
): Electron.Rectangle => {
  const normalizedZoomFactor = resolveRemoteAppViewZoomFactor(mainZoomFactor);
  const viewTop = Math.round((TITLEBAR_HEIGHT + REMOTE_APP_VIEW_TOP_INSET) * normalizedZoomFactor);
  const hostFooterHeight = hostFooterVisible
    ? Math.round(REMOTE_APP_HOST_FOOTER_HEIGHT * normalizedZoomFactor)
    : 0;
  return {
    x: 0,
    y: viewTop,
    width: Math.max(0, contentBounds.width),
    height: Math.max(0, contentBounds.height - viewTop - hostFooterHeight),
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
 * The surfaces the menu offers, in a stable order: T3 first, then the
 * available sites. The active surface is never listed; there is nothing to
 * switch to there.
 */
export const resolveRemoteAppMenuSurfaces = (
  availableSites: ReadonlyArray<RemoteAppSite>,
  activeSurface: DesktopSurface,
): ReadonlyArray<DesktopSurface> =>
  (["t3code", ...REMOTE_APP_SITES] as const).filter(
    (surface) =>
      surface !== activeSurface && (surface === "t3code" || availableSites.includes(surface)),
  );

/** The URL to open for a site: its last persisted page when it belongs to that site. */
export const resolveRemoteAppSiteUrl = (
  site: RemoteAppSite,
  persistedUrl: string | null,
): string =>
  persistedUrl !== null && resolveRemoteAppSiteForUrl(persistedUrl) === site
    ? persistedUrl
    : REMOTE_APP_SITE_DEFINITIONS[site].entryUrl;

export class RemoteAppManagerError extends Schema.TaggedError<RemoteAppManagerError>()(
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
    readonly setAvailableSites: (availability: RemoteAppAvailability) => Effect.Effect<void>;
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
    readonly fillSitePrompt: (
      request: RemoteAppFillPromptRequest,
    ) => Effect.Effect<RemoteAppFillPromptResult, RemoteAppManagerError>;
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

/** Showing a site reads its finished reply, so its badge goes. */
const clearUnread = (state: RemoteAppState, site: RemoteAppSite): RemoteAppState =>
  state.unreadSites?.includes(site)
    ? { ...state, unreadSites: state.unreadSites.filter((unread) => unread !== site) }
    : state;

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const shell = yield* ElectronShell.ElectronShell;
  const sessionService = yield* RemoteAppSession.RemoteAppSession;
  const stateStore = yield* RemoteAppStateStore.RemoteAppStateStore;
  const mainWindowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  const attachedRef = yield* Ref.make(false);
  const stateChangeLock = yield* Semaphore.make(1);
  // Serializes get-or-create, so an activation and a background preload never
  // both create a view for the same site.
  const viewCreationLock = yield* Semaphore.make(1);
  const themeCssLock = yield* Semaphore.make(1);
  const remoteThemeRef = yield* Ref.make<RemoteAppTheme>(DEFAULT_REMOTE_APP_THEME);
  const availableSitesRef = yield* Ref.make<ReadonlyArray<RemoteAppSite>>([]);
  // The available sites the user keeps loaded in the background, in preload order.
  const backgroundSitesRef = yield* Ref.make<ReadonlyArray<RemoteAppSite>>([]);
  // Views are created on first activation or by the background preload, and
  // kept while hidden, so switching sites is instant. Hidden views are detached
  // and background-throttled.
  const views = new Map<RemoteAppSite, Electron.WebContentsView>();
  // Preloaded views that have never been on screen; their first show forces a
  // repaint instead of trusting a frame produced while detached.
  const unseenViews = new WeakSet<Electron.WebContentsView>();
  let preloadFiber: Fiber.Fiber<void> | undefined;
  // The load the preload is waiting on. It outlives a rescheduled preload run,
  // so a restart never starts a second site while one is still loading.
  let preloadLoad: { readonly site: RemoteAppSite; readonly done: Promise<unknown> } | undefined;
  let preloadNotBefore: number | undefined;
  const recoveryCounts = new Map<RemoteAppSite, number>();
  // Sites whose page failed to load or crashed for good; switching back to one
  // reloads it, since no toolbar offers a retry.
  const brokenSites = new Set<RemoteAppSite>();
  const insertedThemeKeys = new Map<RemoteAppSite, string>();
  const sessionsWithDownloadHandler = new WeakSet<Electron.Session>();
  const popupWindows = new Set<Electron.BrowserWindow>();
  let surfaceMenuWindow: Electron.BrowserWindow | null = null;
  // When each kept view last left the screen (or was created hidden).
  const hiddenSince = new Map<RemoteAppSite, number>();
  // Sites the idle sweep released. The background preload leaves them alone
  // until the user opens them again; the set is in memory, so a restart
  // preloads them as usual.
  const idleUnloadedSites = new Set<RemoteAppSite>();
  let idleUnloadMinutes: number | null = null;
  let idleSweepFiber: Fiber.Fiber<void> | undefined;
  // The site an activation is switching to; the idle sweep never releases it.
  let activatingSite: RemoteAppSite | undefined;
  // The latest finished-reply watch armed in each view; older ones are stale.
  const activityTokens = new WeakMap<Electron.WebContentsView, number>();

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
    hiddenSince.delete(site);
    insertedThemeKeys.delete(site);
    recoveryCounts.delete(site);
    brokenSites.delete(site);
    if (preloadLoad?.site === site) preloadLoad = undefined;
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

  /** Badges a site that finished a reply while another surface was on screen. */
  const markUnread = (site: RemoteAppSite) =>
    Effect.gen(function* () {
      const isRead = (state: RemoteAppState) =>
        state.activeSurface === site || (state.unreadSites ?? []).includes(site);
      if (isRead(yield* stateStore.get)) return;
      yield* updateState((state) =>
        isRead(state) ? state : { ...state, unreadSites: [...(state.unreadSites ?? []), site] },
      );
    });

  /**
   * Watches the page for its next finished reply and re-arms after each one.
   * The page script is event-driven (see RemoteAppPageScripts.ts), so a hidden,
   * throttled view is never woken for it. Each document load arms afresh; a
   * watch from an earlier document or a replaced view is ignored.
   */
  const armActivityWatch = (site: RemoteAppSite, view: Electron.WebContentsView): void => {
    const hooks = REMOTE_APP_SITE_DEFINITIONS[site].page;
    const contents = view.webContents;
    if (hooks === undefined || contents.isDestroyed()) return;
    // Sign-in pages on other hosts have no replies to watch.
    if (!isTrustedRemoteUrl(site, contents.getURL())) return;
    const token = (activityTokens.get(view) ?? 0) + 1;
    activityTokens.set(view, token);
    void contents
      .executeJavaScriptInIsolatedWorld(REMOTE_APP_PAGE_WORLD_ID, [
        { code: buildRemoteAppActivityScript(hooks.generating) },
      ])
      .then(
        (signal: unknown) => {
          if (signal !== "finished" || contents.isDestroyed()) return;
          if (views.get(site) !== view || activityTokens.get(view) !== token) return;
          runSafely(markUnread(site));
          armActivityWatch(site, view);
        },
        () => undefined,
      );
  };

  const positionView = (window: Electron.BrowserWindow, view: Electron.WebContentsView) =>
    Effect.flatMap(Ref.get(remoteThemeRef), (theme) =>
      Effect.try({
        try: () => {
          const bounds = window.getContentBounds();
          const zoomFactor = resolveRemoteAppViewZoomFactor(window.webContents.getZoomFactor());
          // The native shell owns application zoom. Keep the live remote page on
          // that same scale so its sidebar width, typography, and responsive
          // breakpoints continue to line up with the host at every zoom level.
          view.webContents.setZoomFactor(zoomFactor);
          // The host footer lives in the sidebar; a collapsed sidebar reports no width.
          view.setBounds(
            resolveRemoteAppViewBounds(bounds, zoomFactor, theme.sidebarWidth !== null),
          );
        },
        catch: (cause) => new RemoteAppManagerError({ operation: "layout", cause }),
      }),
    );

  const openExternal = (url: string) => runSafely(shell.openExternal(url));

  /**
   * Pins the page's sidebar to T3's current width. The inserted site CSS reads
   * the width from a custom property, so width changes never reinsert it.
   */
  const applySidebarWidth = (view: Electron.WebContentsView) =>
    Effect.flatMap(Ref.get(remoteThemeRef), (theme) =>
      Effect.tryPromise({
        try: () =>
          view.webContents.executeJavaScript(buildRemoteAppSidebarWidthScript(theme.sidebarWidth)),
        catch: (cause) => new RemoteAppManagerError({ operation: "theme", cause }),
      }).pipe(Effect.catch(() => Effect.void)),
    );

  const isThemeableSiteUrl = (site: RemoteAppSite, url: string): boolean => {
    if (site === "chatgpt") return isChatGptRemoteAppUrl(url);
    try {
      return isTrustedRemoteHost(site, new URL(url).hostname);
    } catch {
      return false;
    }
  };

  /**
   * Every themeable site gets the active T3 palette as a user stylesheet that
   * repaints its own design tokens, and its sidebar pinned to T3's width; a
   * site with no theme gets only the no-drag rule. Auth pages on other hosts
   * are left alone. ChatGPT also gets the interaction script that tidies its
   * chrome.
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
        const themeable = isThemeableSiteUrl(site, view.webContents.getURL());
        // Insert the new sheet before removing the old one, so a reapply on a
        // visible page never paints a frame without the T3 palette.
        if (themeable) {
          const key = yield* Effect.tryPromise({
            try: () => view.webContents.insertCSS(buildRemoteSiteThemeCss(site, theme)),
            catch: (cause) => new RemoteAppManagerError({ operation: "theme", cause }),
          });
          insertedThemeKeys.set(site, key);
        } else {
          insertedThemeKeys.delete(site);
        }
        if (previousKey !== undefined) {
          yield* Effect.tryPromise({
            try: () => view.webContents.removeInsertedCSS(previousKey),
            catch: (cause) => new RemoteAppManagerError({ operation: "theme", cause }),
          }).pipe(Effect.catch(() => Effect.void));
        }
        if (!themeable || !isThemeableRemoteAppSite(site)) return;
        yield* applySidebarWidth(view);
        if (site !== "chatgpt") return;
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
    contents.on("did-start-loading", () => {
      brokenSites.delete(site);
      runSafely(setLoadingState(site, "loading"));
    });
    for (const event of REMOTE_APP_THEME_DOCUMENT_EVENTS) {
      contents.on(event, () => runSafely(applyRemoteTheme(site, view)));
    }
    contents.on("did-finish-load", () => armActivityWatch(site, view));
    // A failed load also stops loading; keep its failed state instead of "ready".
    contents.on("did-stop-loading", () =>
      runSafely(
        syncNavigation(site, view).pipe(
          Effect.andThen(brokenSites.has(site) ? Effect.void : setLoadingState(site, "ready")),
        ),
      ),
    );
    // Chromium keys zoom by host, so a cross-document navigation (including
    // the first load from about:blank) drops the app scale positionView set.
    contents.on("did-navigate", () =>
      runSafely(positionView(window, view).pipe(Effect.andThen(syncNavigation(site, view)))),
    );
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
      (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
        // ERR_ABORTED (-3) is a navigation superseded by another, not a failure.
        if (!isMainFrame || errorCode === -3) return;
        brokenSites.add(site);
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
            brokenSites.add(site);
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
      if (views.get(site) === view) {
        views.delete(site);
        hiddenSince.delete(site);
      }
      runSafely(
        updateSiteState(site, (state) => ({
          ...state,
          loadState: "crashed",
          error: { category: "renderer", code: "destroyed" },
        })),
      );
    });
    // Same native menu the T3 window shows, plus a way out to the browser.
    contents.on("context-menu", (event, params) => {
      event.preventDefault();
      if (contents.isDestroyed() || window.isDestroyed()) return;
      const template: Electron.MenuItemConstructorOptions[] = [];
      const selection = params.selectionText.trim();
      if (selection.length > 0) {
        template.push(
          {
            label: "Send to T3 Thread",
            click: () => sendSelectionToThread(site, selection),
          },
          { type: "separator" },
        );
      }
      if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
          template.push({
            label: suggestion,
            click: () => {
              if (!contents.isDestroyed()) contents.replaceMisspelling(suggestion);
            },
          });
        }
        if (params.dictionarySuggestions.length === 0) {
          template.push({ label: "No suggestions", enabled: false });
        }
        template.push({ type: "separator" });
      }
      const link = ElectronShell.parseSafeExternalUrl(params.linkURL);
      if (Option.isSome(link)) {
        template.push(
          { label: "Open Link in Browser", click: () => openExternal(link.value) },
          { label: "Copy Link", click: () => runSafely(shell.copyText(link.value)) },
          { type: "separator" },
        );
      }
      if (params.mediaType === "image") {
        template.push(
          {
            label: "Copy Image",
            click: () => {
              if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y);
            },
          },
          { type: "separator" },
        );
      }
      template.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );
      Electron.Menu.buildFromTemplate(template).popup({
        window,
        ...(params.frame ? { frame: params.frame } : {}),
      });
    });
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
    hiddenSince.set(site, Date.now());
    return view;
  });

  const requireLiveWindow = (operation: "attach" | "surface-menu") =>
    getLiveWindow.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new RemoteAppManagerError({ operation, cause: "main window unavailable" })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const ensureView = Effect.fn("remote-app.ensureView")(function* (
    site: RemoteAppSite,
  ): Effect.fn.Return<Electron.WebContentsView, RemoteAppManagerError> {
    const window = yield* requireLiveWindow("attach");
    yield* attachMainWindow(window);
    return yield* viewCreationLock.withPermit(
      Effect.gen(function* () {
        const existing = yield* getLiveView(site);
        if (Option.isSome(existing)) {
          yield* positionView(window, existing.value);
          return existing.value;
        }
        return yield* createView(site, window);
      }),
    );
  });

  /**
   * Creates and starts loading a hidden site's view without touching the
   * persisted shell state, which describes only the active site. The view
   * stays detached and throttled; it is themed and pinned on load like any
   * other. Returns whether a load was started.
   */
  const preloadSite = (site: RemoteAppSite) =>
    Effect.gen(function* () {
      const window = yield* requireLiveWindow("attach");
      yield* attachMainWindow(window);
      return yield* viewCreationLock.withPermit(
        Effect.gen(function* () {
          const state = yield* stateStore.get;
          const available = yield* Ref.get(availableSitesRef);
          const background = yield* Ref.get(backgroundSitesRef);
          if (activeSiteOf(state) === site) return false;
          if (!available.includes(site) || !background.includes(site)) return false;
          if (idleUnloadedSites.has(site)) return false;
          if (Option.isSome(yield* getLiveView(site))) return false;
          const view = yield* createView(site, window);
          unseenViews.add(view);
          // Resolves on did-finish-load; a failed load is left to brokenSites,
          // so activating the site reloads it.
          const done: Promise<unknown> = view.webContents
            .loadURL(resolveRemoteAppSiteUrl(site, state.currentUrl))
            .catch(() => undefined)
            .finally(() => {
              if (preloadLoad?.done === done) preloadLoad = undefined;
            });
          preloadLoad = { site, done };
          return true;
        }),
      );
    });

  const awaitPreloadLoad = Effect.suspend(() => {
    const load = preloadLoad;
    return load === undefined
      ? Effect.void
      : Effect.promise(() => load.done).pipe(
          Effect.timeoutOption(REMOTE_APP_PRELOAD_LOAD_TIMEOUT),
          Effect.asVoid,
        );
  });

  const runPreload = (delayMs: number) =>
    Effect.gen(function* () {
      yield* Effect.sleep(delayMs);
      // Each site is rechecked at its turn; a later availability or
      // background-list change reschedules the whole run.
      for (const site of yield* Ref.get(backgroundSitesRef)) {
        yield* awaitPreloadLoad;
        const started = yield* preloadSite(site).pipe(Effect.catch(() => Effect.succeed(false)));
        if (!started) continue;
        yield* awaitPreloadLoad;
        yield* Effect.sleep(REMOTE_APP_PRELOAD_SETTLE_DELAY);
      }
    });

  const cancelPreload = () => {
    preloadFiber?.interruptUnsafe();
    preloadFiber = undefined;
  };

  /** Restarts the background preload; the first run waits for T3's startup to settle. */
  const schedulePreload = (backgroundSites: ReadonlyArray<RemoteAppSite>) => {
    cancelPreload();
    if (backgroundSites.length === 0) return;
    const now = Date.now();
    preloadNotBefore ??= now + REMOTE_APP_PRELOAD_START_DELAY_MS;
    preloadFiber = Effect.runFork(
      runPreload(Math.max(REMOTE_APP_PRELOAD_RESCHEDULE_DELAY_MS, preloadNotBefore - now)),
    );
  };

  /**
   * Releases kept views that have stayed hidden past the user's limit. One
   * coarse sweep covers every site; the active site, and one being switched
   * to, are never released. Opening a released site loads it again.
   */
  const sweepIdleViews = Effect.gen(function* () {
    if (idleUnloadMinutes === null) return;
    const cutoff = Date.now() - idleUnloadMinutes * 60_000;
    const activeSite = activeSiteOf(yield* stateStore.get);
    const window = yield* getLiveWindow;
    for (const [site, since] of [...hiddenSince]) {
      if (site === activeSite || site === activatingSite || since > cutoff) continue;
      if (!views.has(site)) continue;
      closeView(site, window);
      idleUnloadedSites.add(site);
    }
  });

  const scheduleIdleSweep = (minutes: number | null) => {
    if (minutes === idleUnloadMinutes && (minutes === null || idleSweepFiber !== undefined)) return;
    idleUnloadMinutes = minutes;
    idleSweepFiber?.interruptUnsafe();
    idleSweepFiber = undefined;
    if (minutes === null) return;
    idleSweepFiber = Effect.runFork(
      Effect.forever(
        Effect.sleep(REMOTE_APP_IDLE_SWEEP_INTERVAL).pipe(
          Effect.andThen(sweepIdleViews),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  };

  const showSurface = (surface: DesktopSurface) =>
    Effect.gen(function* () {
      closeSurfaceMenu();
      const window = yield* getLiveWindow;
      if (Option.isNone(window)) return;
      // Detach every other view so the host renderer owns the surface and the
      // next activation reinserts a clean layer beneath it.
      const now = Date.now();
      for (const [site, view] of views) {
        if (site === surface || view.webContents.isDestroyed()) continue;
        if (!hiddenSince.has(site)) hiddenSince.set(site, now);
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
      hiddenSince.delete(surface);
      // Reattach before making it visible while preserving the host shell
      // above the remote page.
      window.value.contentView.removeChildView(view.value);
      addRemoteAppViewBelowHostRenderer(window.value, view.value);
      yield* positionView(window.value, view.value);
      view.value.setVisible(true);
      if (unseenViews.delete(view.value)) view.value.webContents.invalidate();
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
      cancelPreload();
      idleSweepFiber?.interruptUnsafe();
      idleSweepFiber = undefined;
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
      const previous = yield* Ref.getAndSet(remoteThemeRef, theme);
      // Dragging T3's sidebar sends a stream of width-only updates; those just
      // move every site's pin. The menu colors are read when the menu opens.
      const presentationOf = (value: RemoteAppTheme) =>
        JSON.stringify({ ...value, sidebarWidth: null, menu: null });
      const presentationChanged = presentationOf(previous) !== presentationOf(theme);
      const widthChanged = previous.sidebarWidth !== theme.sidebarWidth;
      for (const site of presentationChanged || widthChanged ? [...views.keys()] : []) {
        const view = yield* getLiveView(site);
        if (Option.isNone(view)) continue;
        // applyRemoteTheme pins the width too.
        if (presentationChanged) yield* applyRemoteTheme(site, view.value);
        else if (isThemeableRemoteAppSite(site)) yield* applySidebarWidth(view.value);
      }
      if ((previous.sidebarWidth === null) !== (theme.sidebarWidth === null)) {
        const window = yield* getLiveWindow;
        const site = activeSiteOf(yield* stateStore.get);
        const view = site === undefined ? Option.none() : yield* getLiveView(site);
        if (Option.isSome(window) && Option.isSome(view)) {
          yield* positionView(window.value, view.value);
        }
      }
    }).pipe(
      Effect.mapError((cause) =>
        isRemoteAppManagerError(cause)
          ? cause
          : new RemoteAppManagerError({ operation: "theme", cause }),
      ),
    );

  const setAvailableSites = ({
    sites,
    backgroundSites,
    idleUnloadMinutes: idleMinutes,
  }: RemoteAppAvailability) =>
    Effect.gen(function* () {
      scheduleIdleSweep(idleMinutes);
      const background = backgroundSites.filter((site) => sites.includes(site));
      yield* Ref.set(availableSitesRef, sites);
      const previousBackground = yield* Ref.getAndSet(backgroundSitesRef, background);
      const backgroundChanged = previousBackground.join(",") !== background.join(",");
      // Release the memory of hidden sites that are no longer available or no
      // longer kept in the background, including one still preloading. A site
      // opened by hand outside the background list keeps its view after the
      // user leaves it, until the background list next changes. The renderer
      // moves off an active site that became unavailable.
      const activeSite = activeSiteOf(yield* stateStore.get);
      const window = yield* getLiveWindow;
      for (const site of [...views.keys()]) {
        if (site === activeSite) continue;
        if (!sites.includes(site) || (backgroundChanged && !background.includes(site))) {
          closeView(site, window);
        }
      }
      schedulePreload(background);
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
    // The switcher offers no menu when there is nothing to switch to.
    if (surfaces.length === 0) return;

    // A transparent window gets neither native rounded corners nor a native
    // shadow, so the menu is an opaque frameless window the platform rounds
    // and shadows. On macOS its background is native vibrancy, tinted by the
    // page like T3's dropdown-glass; elsewhere the page paints the opaque
    // popover color.
    const material: RemoteAppSurfaceMenuMaterial =
      process.platform === "darwin" ? "vibrancy" : "opaque";
    const materialOptions: Electron.BrowserWindowConstructorOptions =
      material === "vibrancy"
        ? { vibrancy: "menu", visualEffectState: "active", backgroundColor: "#00000000" }
        : { backgroundColor: resolveRemoteAppSurfaceMenuBackground(theme) };
    const menu = yield* Effect.try({
      try: () =>
        new Electron.BrowserWindow({
          parent: owner,
          modal: false,
          frame: false,
          transparent: false,
          roundedCorners: true,
          hasShadow: true,
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          focusable: true,
          skipTaskbar: true,
          show: false,
          ...materialOptions,
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
      // Escape navigates to a non-surface URL; anything but a surface just closes.
      closeSurfaceMenu();
      if (surface !== undefined) runSafely(setActiveSurface(surface));
    });
    menu.on("blur", closeSurfaceMenu);
    menu.on("closed", () => {
      if (surfaceMenuWindow === menu) surfaceMenuWindow = null;
    });

    const zoomFactor = owner.webContents.getZoomFactor();
    const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
    const contentBounds = owner.getContentBounds();
    // The menu scales with T3's zoom, as T3's own menus do.
    const menuWidth = Math.round(REMOTE_APP_SURFACE_MENU_WIDTH * scale);
    const menuHeight = Math.round(resolveRemoteAppSurfaceMenuHeight(surfaces) * scale);
    // The window is the popup itself: its left edge aligns with the trigger
    // and its top sits 4px below it, as T3's menus do.
    const requestedX = contentBounds.x + Math.round(anchor.x * scale);
    const requestedY = contentBounds.y + Math.round((anchor.y + anchor.height + 4) * scale);
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
      buildRemoteAppSurfaceMenuHtml(theme, surfaces, material, state.unreadSites ?? []),
    )}`;
    yield* Effect.tryPromise({
      try: () => menu.loadURL(documentUrl),
      catch: (cause) => new RemoteAppManagerError({ operation: "surface-menu", cause }),
    }).pipe(Effect.tapError(() => Effect.sync(closeSurfaceMenu)));
    if (!menu.isDestroyed()) {
      // After load: a navigation can reset a page's zoom.
      menu.webContents.setZoomFactor(scale);
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
      activatingSite = site;
      // Opening a site the idle sweep released brings it back into the preload.
      idleUnloadedSites.delete(site);
      const view = yield* ensureView(site);
      const previous = yield* stateStore.get;
      yield* showSurface(site);
      if (brokenSites.has(site)) {
        brokenSites.delete(site);
        const url = resolveRemoteAppSiteUrl(site, view.webContents.getURL() || previous.currentUrl);
        yield* updateState((state) =>
          clearUnread(
            { ...state, activeSurface: site, loadState: "loading", currentUrl: url, error: null },
            site,
          ),
        );
        yield* loadUrl(view, url);
        return;
      }
      // A preload that has not committed yet is already loading the right page.
      if (view.webContents.getURL().length === 0 && !view.webContents.isLoading()) {
        const url = resolveRemoteAppSiteUrl(site, previous.currentUrl);
        yield* updateState((state) =>
          clearUnread(
            {
              ...state,
              activeSurface: site,
              loadState: "loading",
              currentUrl: url,
              currentTitle: REMOTE_APP_SITE_INFO[site].label,
              canGoBack: false,
              canGoForward: false,
              error: null,
            },
            site,
          ),
        );
        yield* loadUrl(view, url);
        return;
      }
      // A kept view already holds its page; describe it from the view itself.
      yield* updateState((state) => {
        const sameSite = state.activeSurface === site;
        return clearUnread(
          {
            ...updateNavigationState(view, {
              ...state,
              currentUrl: sameSite ? state.currentUrl : REMOTE_APP_SITE_DEFINITIONS[site].entryUrl,
              currentTitle: sameSite ? state.currentTitle : REMOTE_APP_SITE_INFO[site].label,
            }),
            activeSurface: site,
            loadState: view.webContents.isLoading() ? "loading" : "ready",
          },
          site,
        );
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (activatingSite === site) activatingSite = undefined;
        }),
      ),
    );

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
    brokenSites.delete(site);
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
      currentTitle: REMOTE_APP_SITE_INFO[site].label,
      recents: current.recents.filter((recent) => resolveRemoteAppSiteForUrl(recent.url) !== site),
      unreadSites: (current.unreadSites ?? []).filter((unread) => unread !== site),
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

  /**
   * Hands a web app selection to the renderer, which appends it to the most
   * recent T3 thread's draft. T3 comes on screen first so the renderer can
   * navigate to that thread.
   */
  const sendSelectionToThread = (site: RemoteAppSite, text: string) =>
    runSafely(
      Effect.gen(function* () {
        yield* setActiveSurface("t3code");
        const window = yield* getLiveWindow;
        if (Option.isNone(window) || window.value.webContents.isDestroyed()) return;
        const send: RemoteAppSendToThread = {
          site,
          text: text.slice(0, REMOTE_APP_TRANSFER_TEXT_MAX_LENGTH),
        };
        window.value.webContents.send(REMOTE_APP_SEND_TO_THREAD_CHANNEL, send);
      }),
    );

  const awaitPageLoaded = (contents: Electron.WebContents) =>
    contents.isLoading()
      ? Effect.callback<void>((resume) => {
          const done = () => resume(Effect.void);
          contents.once("did-stop-loading", done);
          return Effect.sync(() => {
            if (!contents.isDestroyed()) contents.removeListener("did-stop-loading", done);
          });
        }).pipe(Effect.timeoutOption(REMOTE_APP_FILL_LOAD_TIMEOUT), Effect.asVoid)
      : Effect.void;

  // Runs a page script in the shell's isolated world; any failure reads as undefined.
  const runPageScript = (contents: Electron.WebContents, code: string) =>
    Effect.tryPromise({
      try: (): Promise<unknown> =>
        contents.executeJavaScriptInIsolatedWorld(REMOTE_APP_PAGE_WORLD_ID, [{ code }]),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed<unknown>(undefined)));

  /**
   * Switches to an available site and types T3 text into its prompt box. It
   * never submits: the page script inserts text only, and nothing here sends
   * a key. When the box can't be filled, the text goes on the clipboard and the
   * user is told on the site's page, because T3 toasts sit beneath the site's
   * view; if the page can't show that either (a sign-in page, a failed load),
   * the shell returns to T3 so the renderer's toast is visible.
   */
  const fillSitePrompt = ({ site, text }: RemoteAppFillPromptRequest) =>
    Effect.gen(function* () {
      if (!(yield* Ref.get(availableSitesRef)).includes(site)) {
        return "unavailable" satisfies RemoteAppFillPromptResult;
      }
      yield* setActiveSurface(site);
      const view = yield* getLiveView(site);
      const contents = Option.isSome(view) ? view.value.webContents : undefined;
      if (contents !== undefined && !contents.isDestroyed()) yield* awaitPageLoaded(contents);
      // Never touch a sign-in page, or a site the user already left.
      const stillActive = activeSiteOf(yield* stateStore.get) === site;
      const page =
        stillActive &&
        contents !== undefined &&
        !contents.isDestroyed() &&
        isTrustedRemoteUrl(site, contents.getURL())
          ? contents
          : undefined;
      const hooks = REMOTE_APP_SITE_DEFINITIONS[site].page;
      if (page !== undefined && hooks !== undefined) {
        const outcome = yield* runPageScript(
          page,
          buildRemoteAppPromptFillScript(hooks.promptInput, text),
        );
        if (outcome === "filled") return "filled" satisfies RemoteAppFillPromptResult;
      }
      yield* shell.copyText(text);
      if (page !== undefined && !page.isDestroyed()) {
        const shown = yield* runPageScript(
          page,
          buildRemoteAppNoticeScript(
            `Couldn't find ${REMOTE_APP_SITE_INFO[site].label}'s prompt box. The text is on your clipboard; paste it there.`,
          ),
        );
        if (shown === true) return "copied" satisfies RemoteAppFillPromptResult;
      }
      if (activeSiteOf(yield* stateStore.get) === site) yield* setActiveSurface("t3code");
      return "input-not-found" satisfies RemoteAppFillPromptResult;
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
    fillSitePrompt,
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
