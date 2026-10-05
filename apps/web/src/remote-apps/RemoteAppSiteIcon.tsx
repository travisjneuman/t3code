import { REMOTE_APP_SURFACE_ICON_SVGS, type DesktopSurface } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

// Built once: each surface's tile as an image, the same set the desktop menu inlines.
const ICON_URLS = Object.fromEntries(
  Object.entries(REMOTE_APP_SURFACE_ICON_SVGS).map(([surface, svg]) => [
    surface,
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  ]),
) as Readonly<Record<DesktopSurface, string>>;

export function RemoteAppSiteIcon({
  site,
  className,
}: {
  readonly site: DesktopSurface;
  readonly className?: string;
}) {
  return (
    <img
      src={ICON_URLS[site]}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn("size-4 shrink-0", className)}
    />
  );
}
