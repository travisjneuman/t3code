import type { EnvironmentId } from "@t3tools/contracts";
import type { MouseEvent } from "react";

import { useScratchProject } from "../hooks/useScratchProject";

/** Fork add-on: a plain click starts without a project; Shift keeps upstream's project action. */
export function useScratchThreadClick(
  preferredEnvironmentId: EnvironmentId | null,
  onStart: () => void,
) {
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  return (event?: Pick<MouseEvent, "shiftKey">): boolean => {
    const scratchTarget = scratchEnvironmentId(preferredEnvironmentId);
    if ((event?.shiftKey ?? false) || scratchTarget === null) return false;
    onStart();
    void startScratchThread(scratchTarget);
    return true;
  };
}
