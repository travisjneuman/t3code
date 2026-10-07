import { toastManager } from "../components/ui/toast";

/**
 * Replaces upstream's "Update downloaded" toast for a source update: the build
 * is local, so there are no release notes to link. Fork add-on: local source updates.
 */
export function showSourceUpdateBuiltToast(): void {
  toastManager.add({
    type: "success",
    title: "Local update built",
    description: "Restart the app from the update button to replace it with the local build.",
  });
}
