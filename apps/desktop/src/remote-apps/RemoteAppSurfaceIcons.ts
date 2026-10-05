import { REMOTE_APP_SURFACE_ICON_SVGS, type DesktopSurface } from "@t3tools/contracts";

/**
 * Inline SVG icons for the surface menu, which renders in its own small
 * document with no access to the web app's icon components. The set is shared
 * with the web switcher; see packages/contracts/src/remoteAppIcons.ts.
 */
export const REMOTE_APP_SURFACE_ICONS: Readonly<Record<DesktopSurface, string>> =
  REMOTE_APP_SURFACE_ICON_SVGS;
