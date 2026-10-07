import type { DesktopRemoteAppBridge, RemoteAppSite } from "@t3tools/contracts";
import { create } from "zustand";

import { effectiveRemoteAppChatMode, useRemoteAppPanelMemory } from "./remoteAppPanelMemory";

/** The desktop bridge, when this desktop build can host web apps in the side panel. */
export function readRemoteAppPanelBridge(): DesktopRemoteAppBridge | undefined {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.remoteApps;
  return bridge !== undefined && typeof bridge.attachPanel === "function" ? bridge : undefined;
}

/** The browser-surface slot a site's panel page is placed by. */
export const remoteAppPanelSlotId = (site: RemoteAppSite): string => `remote-app-panel:${site}`;

/** The Electron `<webview>` methods the panel uses. */
export interface RemoteAppPanelWebview extends HTMLElement {
  getWebContentsId: () => number;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
}

/**
 * Whose chat the live page holds: the shared chat (`threadKey` null) or one
 * thread's own chat. Navigation reports are remembered for this context, so a
 * page that changes while hidden still updates the chat it belongs to.
 */
interface PanelContext {
  readonly key: string;
  readonly threadKey: string | null;
}

interface PanelRuntime {
  readonly element: RemoteAppPanelWebview;
  readonly bridge: DesktopRemoteAppBridge;
  /** Null for a page loaded before any thread claimed it. */
  context: PanelContext | null;
  /** The page's last reported (or last requested) URL; null when unknown. */
  url: string | null;
}

const SHARED_CONTEXT: PanelContext = { key: "shared", threadKey: null };
const runtimes = new Map<RemoteAppSite, PanelRuntime>();

interface PanelNavigation {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** Back and forward availability per site, for the panel's header buttons. */
export const useRemoteAppPanelNavigation = create<{
  readonly bySite: Partial<Record<RemoteAppSite, PanelNavigation>>;
}>()(() => ({ bySite: {} }));

function contextFor(
  site: RemoteAppSite,
  threadKey: string | null,
): { readonly context: PanelContext | null; readonly target: string | null } {
  const memory = useRemoteAppPanelMemory.getState();
  if (effectiveRemoteAppChatMode(memory, threadKey, site) === "shared") {
    return { context: SHARED_CONTEXT, target: memory.sharedUrl[site] ?? null };
  }
  if (threadKey === null) return { context: null, target: null };
  return {
    context: { key: `own:${threadKey}`, threadKey },
    target: memory.threadLinks[threadKey]?.[site] ?? null,
  };
}

function navigate(runtime: PanelRuntime, site: RemoteAppSite, target: string | null): void {
  // Assumed until the page reports, so a quick switch back compares against
  // where the page is going rather than where it was.
  runtime.url = target;
  void runtime.bridge.navigatePanel(site, target).catch(() => undefined);
}

export function refreshRemoteAppPanelNavigation(site: RemoteAppSite): void {
  const element = runtimes.get(site)?.element;
  let next: PanelNavigation = { canGoBack: false, canGoForward: false };
  try {
    if (element) next = { canGoBack: element.canGoBack(), canGoForward: element.canGoForward() };
  } catch {
    // The guest is not attached (yet or any more).
  }
  const current = useRemoteAppPanelNavigation.getState().bySite[site];
  if (current?.canGoBack === next.canGoBack && current.canGoForward === next.canGoForward) return;
  useRemoteAppPanelNavigation.setState((state) => ({ bySite: { ...state.bySite, [site]: next } }));
}

/** Adopts an attached page and loads the chat of the thread on screen, if any. */
export function startRemoteAppPanel(
  site: RemoteAppSite,
  element: RemoteAppPanelWebview,
  bridge: DesktopRemoteAppBridge,
  threadKey: string | null,
): void {
  const { context, target } = contextFor(site, threadKey);
  const runtime: PanelRuntime = { element, bridge, context, url: null };
  runtimes.set(site, runtime);
  navigate(runtime, site, target);
  refreshRemoteAppPanelNavigation(site);
}

export function stopRemoteAppPanel(site: RemoteAppSite, element: RemoteAppPanelWebview): void {
  if (runtimes.get(site)?.element !== element) return;
  runtimes.delete(site);
  refreshRemoteAppPanelNavigation(site);
}

/** Points the live page at the chat `threadKey` should show, when it shows another. */
export function showRemoteAppPanelFor(site: RemoteAppSite, threadKey: string): void {
  const runtime = runtimes.get(site);
  if (runtime === undefined) return;
  const { context, target } = contextFor(site, threadKey);
  if (context !== null && context.key === runtime.context?.key) return;
  const unclaimed = runtime.context === null;
  runtime.context = context;
  // A fresh entry page nobody claimed yet already is the new chat this thread wants.
  if (unclaimed && target === null) return;
  if (target !== null && target === runtime.url) return;
  navigate(runtime, site, target);
}

/** Remembers where the page went for the chat it currently holds. */
export function recordRemoteAppPanelNavigation(site: RemoteAppSite, url: string | null): void {
  const runtime = runtimes.get(site);
  if (runtime === undefined) return;
  runtime.url = url;
  refreshRemoteAppPanelNavigation(site);
  if (url === null || runtime.context === null) return;
  const memory = useRemoteAppPanelMemory.getState();
  if (runtime.context.threadKey === null) memory.setSharedUrl(site, url);
  else memory.setThreadLink(runtime.context.threadKey, site, url);
}

/**
 * Before a thread switches to its own chat, keeps the chat on screen as that
 * chat, so the switch does not throw away what the user is looking at.
 */
export function adoptRemoteAppPanelPage(site: RemoteAppSite, threadKey: string): void {
  const runtime = runtimes.get(site);
  if (runtime === undefined || runtime.url === null || runtime.context === null) return;
  if (runtime.context.threadKey !== null && runtime.context.threadKey !== threadKey) return;
  const memory = useRemoteAppPanelMemory.getState();
  if (memory.threadLinks[threadKey]?.[site] !== undefined) return;
  memory.setThreadLink(threadKey, site, runtime.url);
}

/** Forgets a thread's own chat; a page showing it starts a new one. */
export function forgetRemoteAppPanelThreadChat(site: RemoteAppSite, threadKey: string): void {
  useRemoteAppPanelMemory.getState().setThreadLink(threadKey, site, null);
  const runtime = runtimes.get(site);
  if (runtime?.context?.threadKey === threadKey) navigate(runtime, site, null);
}

function withElement(site: RemoteAppSite, action: (element: RemoteAppPanelWebview) => void) {
  const element = runtimes.get(site)?.element;
  if (element === undefined) return;
  try {
    action(element);
  } catch {
    // The guest went away between the click and the call.
  }
}

export const remoteAppPanelGoBack = (site: RemoteAppSite) =>
  withElement(site, (element) => element.goBack());
export const remoteAppPanelGoForward = (site: RemoteAppSite) =>
  withElement(site, (element) => element.goForward());
export const remoteAppPanelReload = (site: RemoteAppSite) =>
  withElement(site, (element) => element.reload());
