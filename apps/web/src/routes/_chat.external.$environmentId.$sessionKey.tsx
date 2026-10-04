import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ExternalSessionView } from "../external-sessions/ExternalSessionView";

// Live view of an agent session running outside T3 (fork add-on).
export const Route = createFileRoute("/_chat/external/$environmentId/$sessionKey")({
  component: ExternalSessionRouteView,
});

function ExternalSessionRouteView() {
  const { environmentId, sessionKey } = Route.useParams();
  return (
    <ExternalSessionView
      key={`${environmentId}\u0000${sessionKey}`}
      environmentId={environmentId as EnvironmentId}
      sessionKey={sessionKey}
    />
  );
}
