import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { parsePairId } from "../compare-agents/compareAgents";
import { CompareAgentsView } from "../compare-agents/CompareAgentsView";

interface CompareSearch {
  readonly pair?: string;
  readonly project?: string;
}

// Compare agents: setup form, or a comparison's two sides with `pair` (fork add-on).
export const Route = createFileRoute("/_chat/compare/$environmentId")({
  validateSearch: (raw: Record<string, unknown>): CompareSearch => {
    const pair = parsePairId(raw.pair);
    return {
      ...(pair !== undefined ? { pair } : {}),
      ...(typeof raw.project === "string" && raw.project
        ? { project: raw.project.slice(0, 200) }
        : {}),
    };
  },
  component: CompareRouteView,
});

function CompareRouteView() {
  const { environmentId } = Route.useParams();
  const { pair, project } = Route.useSearch();
  return (
    <CompareAgentsView
      key={`${environmentId}\u0000${pair ?? ""}`}
      environmentId={environmentId as EnvironmentId}
      pairId={pair}
      projectId={project}
    />
  );
}
