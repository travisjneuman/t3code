import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EditorId, EnvironmentId } from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { isAbsolutePath } from "@t3tools/shared/path";
import { useCallback } from "react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { serverEnvironment } from "../../state/server";
import { toastManager } from "../ui/toast";

const NO_EDITORS: readonly EditorId[] = [];

/**
 * Opens a file a session changed in the environment's configured editor,
 * resolving a relative path against the session's folder. Fork add-on.
 */
export function useOpenSessionFile(environmentId: EnvironmentId, cwd: string | undefined) {
  const availableEditors =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.availableEditors ?? NO_EDITORS;
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  return useCallback(
    async (path: string) => {
      const target =
        cwd !== undefined ? resolvePathLinkTarget(path, cwd) : isAbsolutePath(path) ? path : null;
      if (target === null) return;
      const result = await openInPreferredEditor(target);
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Unable to open file",
        description: error instanceof Error ? error.message : target,
      });
    },
    [cwd, openInPreferredEditor],
  );
}
