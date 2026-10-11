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
    id: "agent-review-worker-model",
    title: "Review worker model",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["delegate_task reviewer review role subagent model target"],
  },
  {
    id: "agent-research-worker-model",
    title: "Research worker model",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["delegate_task researcher research role subagent model target"],
  },
  {
    id: "agent-parallel-workers",
    title: "Parallel workers",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["max concurrent subagents workers at once limit"],
  },
  {
    id: "agent-review-rounds",
    title: "Review rounds",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["review loop reviewer passes until clean findings"],
  },
  {
    id: "agent-read-only-reviewers",
    title: "Read-only reviewers",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["reviewer researcher no edits read only permissions sandbox"],
  },
  {
    id: "agent-workers-can-delegate",
    title: "Workers can delegate",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["nested delegation subagents spawn depth recursive"],
  },
  {
    id: "agent-git-owner",
    title: "Orchestrator handles git",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["workers commit push publishing git owner"],
  },
  {
    id: "agent-verification",
    title: "Verification",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["tests lint typecheck build checks review verify"],
  },
  {
    id: "agent-push-policy",
    title: "Commit and push",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["git commit push publish never after each change"],
  },
  {
    id: "agent-instructions",
    title: "Additional instructions",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["agent instructions system prompt claude.md agents.md override rules custom"],
  },
  {
    id: "agent-preview",
    title: "What agents receive",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["preview agent instructions system prompt generated text"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
