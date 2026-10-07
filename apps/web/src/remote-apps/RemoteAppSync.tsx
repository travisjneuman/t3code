import { RemoteAppSiteSync } from "./RemoteAppSiteSync";
import { RemoteAppThemeSync } from "./RemoteAppThemeSync";

/**
 * Renderer-wide remote-app effects, mounted once at the app root. Keeping the
 * theme and site sync subscribed for the whole session also keeps the shared
 * remote-app state store connected to the desktop bridge.
 */
export function RemoteAppSync() {
  return (
    <>
      <RemoteAppThemeSync />
      <RemoteAppSiteSync />
    </>
  );
}
