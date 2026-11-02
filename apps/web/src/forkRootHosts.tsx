/**
 * The fork's app-wide coordinators and dialog hosts, mounted in the root route through this one
 * component inside the first-run gate. Fork add-on.
 *
 * @module forkRootHosts
 */
import { FindCheckoutsDialogHost } from "./components/settings/FindCheckoutsDialog";
import { HostReleaseAutoUpdate } from "./host-release/HostReleaseAutoUpdate";
import { MaintenanceQueueCoordinator } from "./maintenance-queue/MaintenanceQueueCoordinator";

export function ForkRootHosts() {
  return (
    <>
      <MaintenanceQueueCoordinator /> {/* Fork add-on(maintenance-queue) */}
      <HostReleaseAutoUpdate /> {/* Fork add-on(host-releases) */}
      <FindCheckoutsDialogHost /> {/* Fork add-on(existing-checkout) */}
    </>
  );
}
