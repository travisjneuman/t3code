import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { RemoteAppProvider } from "./remote-apps/useRemoteAppState";
import { RemoteAppSiteSync } from "./remote-apps/RemoteAppSiteSync";
import { RemoteAppThemeSync } from "./remote-apps/RemoteAppThemeSync";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RemoteAppProvider>
        <RemoteAppThemeSync />
        <RemoteAppSiteSync />
        <RouterProvider router={router} />
        <ElectronBrowserHost />
        <QuitHoldOverlay />
      </RemoteAppProvider>
    </AppAtomRegistryProvider>
  );
}
