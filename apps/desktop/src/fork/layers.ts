// Fork add-on layers that main.ts merges into the upstream desktop runtime.
import * as Layer from "effect/Layer";

import * as RemoteAppManager from "../remote-apps/RemoteAppManager.ts";
import * as RemoteAppSession from "../remote-apps/RemoteAppSession.ts";
import * as RemoteAppStateStore from "../remote-apps/RemoteAppStateStore.ts";
import * as ForkDesktopUpdates from "../updates/ForkDesktopUpdates.ts";
import * as HostReleasePublisher from "../updates/HostReleasePublisher.ts";

/**
 * Remote apps. Provided last in the application chain so DesktopWindow finds the
 * manager when it builds; desktop foundation and Electron services come from main.ts.
 */
export const remoteApps = RemoteAppManager.layer.pipe( // Fork add-on(web-apps)
  Layer.provideMerge(Layer.mergeAll(RemoteAppStateStore.layer, RemoteAppSession.layer)),
);

/** Replaces DesktopUpdates.layer. The host-release publisher follows the source updater's builds. */
export const updates = HostReleasePublisher.layer.pipe( // Fork add-on(host-releases)
  Layer.provideMerge(ForkDesktopUpdates.layer), // Fork add-on(upstream-sync)
);
