import type { UseNavigateResult } from "@tanstack/react-router";
import { useCallback } from "react";

import { setRemoteAppSurface } from "./useRemoteAppState";

/**
 * Wraps a `useNavigate()` result so it first brings T3 back in front of any
 * remote site, and a sidebar footer action that opens a T3 page is visible when
 * it lands. On the web, with no desktop bridge, the surface switch resolves
 * immediately.
 */
export function useT3SurfaceNavigate(
  navigate: UseNavigateResult<string>,
): UseNavigateResult<string> {
  return useCallback<UseNavigateResult<string>>(
    (options) => setRemoteAppSurface("t3code").then(() => navigate(options)),
    [navigate],
  );
}
