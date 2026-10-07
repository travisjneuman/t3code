import type { ReactNode } from "react";

import type { DesktopUpdateButtonAction } from "../components/desktopUpdate.logic";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { getSourceUpdateActionLabel } from "./sourceUpdateWording";

/**
 * Shows the source-update label for `action` on a local source build, else
 * upstream's label passed as children. It reads the update state itself so the
 * caller needs no extra props. Fork add-on: local source updates.
 */
export function SourceUpdateActionLabel({
  action,
  children,
}: {
  readonly action: DesktopUpdateButtonAction;
  readonly children: ReactNode;
}) {
  const state = useDesktopUpdateState();
  return state?.sourceUpdate ? getSourceUpdateActionLabel(action) : children;
}
