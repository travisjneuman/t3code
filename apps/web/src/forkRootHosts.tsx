/**
 * The fork's app-wide coordinators and dialog hosts, mounted in the root route through this one
 * component inside the first-run gate. Fork add-on.
 *
 * @module forkRootHosts
 */
import type { ComponentType } from "react";

// fork-addons:begin
import { FindCheckoutsDialogHost } from "./components/settings/FindCheckoutsDialog"; // Fork add-on(existing-checkout)
import { HostReleaseAutoUpdate } from "./host-release/HostReleaseAutoUpdate"; // Fork add-on(host-releases)
import { MaintenanceQueueCoordinator } from "./maintenance-queue/MaintenanceQueueCoordinator"; // Fork add-on(maintenance-queue)

const FORK_ROOT_HOSTS: ReadonlyArray<readonly [key: string, ComponentType]> = [
  ["maintenance-queue", MaintenanceQueueCoordinator], // Fork add-on(maintenance-queue)
  ["host-releases", HostReleaseAutoUpdate], // Fork add-on(host-releases)
  ["existing-checkout", FindCheckoutsDialogHost], // Fork add-on(existing-checkout)
];
// fork-addons:end

export function ForkRootHosts() {
  return <>{FORK_ROOT_HOSTS.map(([key, Host]) => <Host key={key} />)}</>;
}
