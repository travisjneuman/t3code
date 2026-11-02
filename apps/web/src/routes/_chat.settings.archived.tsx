import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../external-sessions/ArchivedExternalSessions"; // Fork add-on(other-agents): archived Other Agents sessions.

export const Route = createFileRoute("/_chat/settings/archived")({
  component: ArchivedThreadsPanel,
});
