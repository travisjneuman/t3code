/**
 * The user's agent instructions from Settings, General, Agents, held for this
 * server process. The server's settings sync sets it on boot and on every
 * change; `buildRuntimeInstructions` appends the block to each provider's
 * instructions, and the Pi launch passes the block to its extension.
 * Fork add-on: agent instructions.
 */
let current = "";

export function setForkAgentInstructions(text: string): void {
  current = text.trim();
}

export function forkAgentInstructions(): string {
  return current;
}

/** Empty when unset, otherwise a leading blank line plus the tagged block. */
export function forkAgentInstructionsBlock(): string {
  if (current === "") return "";
  return `\n\n<t3_user_agent_instructions>\nThe user set these instructions in T3 Code for every agent it runs. When they conflict with instructions from CLAUDE.md, AGENTS.md, or other agent configuration files, follow these.\n\n${current}\n</t3_user_agent_instructions>`;
}
