import { remoteAppSiteForPartition } from "@t3tools/contracts";

import * as Electron from "electron";

// Sessions of remote-app partitions a side-panel `<webview>` attached with.
// Electron caches one Session per partition, so a guest is a side-panel page
// exactly when its session is in here.
const sidePanelSessions = new WeakSet<Electron.Session>();

/**
 * The main window's `will-attach-webview` gate for side-panel pages. Returns
 * true when the partition belongs to a remote app, after either rejecting the
 * attach or hardening it like the full-window view: the page starts blank
 * (RemoteAppManager.navigatePanel loads the site once it adopts the page), has
 * no preload, and runs sandboxed and isolated. False leaves the attach to the
 * preview gate.
 */
export const guardRemoteAppWebview = (
  event: Electron.Event,
  webPreferences: Electron.WebPreferences,
  params: Record<string, string | undefined>,
  isDevelopment: boolean,
): boolean => {
  const partition = params.partition;
  if (partition === undefined || remoteAppSiteForPartition(partition) === undefined) return false;
  const src = params.src ?? "";
  if (src !== "" && src !== "about:blank") {
    event.preventDefault();
    return true;
  }
  delete webPreferences.preload;
  delete params.preload;
  webPreferences.sandbox = true;
  webPreferences.contextIsolation = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.experimentalFeatures = false;
  webPreferences.webviewTag = false;
  webPreferences.spellcheck = true;
  webPreferences.devTools = isDevelopment;
  sidePanelSessions.add(Electron.session.fromPartition(partition));
  return true;
};

/**
 * A side-panel page, which RemoteAppManager.attachPanel adopts. The preview
 * browser's attach setup (its context menu and control session) must skip it.
 */
export const isRemoteAppWebview = (contents: Electron.WebContents): boolean =>
  sidePanelSessions.has(contents.session);
