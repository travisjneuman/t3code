import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../external-sessions/ArchivedExternalSessions"; // Fork add-on: archived Other Agents sessions.

export const Route = createFileRoute("/settings/archived")({
  component: ArchivedThreadsPanel,
});
