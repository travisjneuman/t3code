/**
 * Settings search entries for the Agents rows, spread into
 * `SETTINGS_SEARCH_ITEMS`. Kept apart from the rows so the search catalog does
 * not import components. Fork add-on: agent instructions.
 */
import type { SettingsSearchItem } from "../components/settings/settingsSearch";

export const AGENT_INSTRUCTIONS_SETTINGS_SEARCH_ITEMS = [
  {
    id: "agent-delegation",
    title: "Delegation",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["delegate_task subagents orchestrator workers orchestrate hand off agents"],
  },
  {
    id: "agent-worker-model",
    title: "Worker model",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["delegate_task subagent child worker provider model target pi codex"],
  },
  {
    id: "agent-parallel-workers",
    title: "Parallel workers",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["max concurrent subagents workers at once limit"],
  },
  {
    id: "agent-git-owner",
    title: "Orchestrator handles git",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["workers commit push publishing git owner"],
  },
  {
    id: "agent-instructions",
    title: "Additional instructions",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["agent instructions system prompt claude.md agents.md override rules custom"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
