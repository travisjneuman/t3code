import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../forkArchivedPanel"; // Fork add-on(core): archived sections from add-ons.

export const Route = createFileRoute("/_chat/settings/archived")({
  component: ArchivedThreadsPanel,
});
