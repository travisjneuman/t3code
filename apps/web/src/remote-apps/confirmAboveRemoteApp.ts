/**
 * Remote WebContentsViews are composited above the host renderer, so a renderer
 * confirmation opened while a remote site is showing (the sidebar's update
 * install, for one) would sit hidden behind it. This answers through the native
 * confirmation then, without changing surface state, and returns null when the
 * renderer's own dialog is visible. `localApi`'s `dialogs.confirm` calls it
 * first. Fork add-on: remote apps.
 */
export async function confirmAboveRemoteApp(message: string): Promise<boolean | null> {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const nativeConfirm = bridge?.confirm;
  const remoteApps = bridge?.remoteApps;
  if (typeof nativeConfirm !== "function" || !remoteApps) return null;
  let activeSurface: string;
  try {
    activeSurface = (await remoteApps.getState()).activeSurface;
  } catch {
    // Fall back to the renderer confirmation if an older shell or a transient
    // remote-app state lookup cannot provide the native prompt.
    return null;
  }
  return activeSurface === "t3code" ? null : nativeConfirm(message);
}
