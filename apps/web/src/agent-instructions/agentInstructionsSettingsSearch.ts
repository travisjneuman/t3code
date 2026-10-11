/**
 * Settings search entry for the agent instructions row, spread into
 * `SETTINGS_SEARCH_ITEMS`. Kept apart from the row so the search catalog does
 * not import components. Fork add-on: agent instructions.
 */
import type { SettingsSearchItem } from "../components/settings/settingsSearch";

export const AGENT_INSTRUCTIONS_SETTINGS_SEARCH_ITEMS = [
  {
    id: "agent-instructions",
    title: "Agent instructions",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: [
      "system prompt claude.md agents.md override rules delegate subagents orchestrator workers",
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
