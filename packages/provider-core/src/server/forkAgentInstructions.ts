/**
 * The instructions built from Settings, General, Agents, held for this server
 * process: one text for the environment and one per project that overrides
 * any Agents setting. The server's settings sync sets them on boot and on every
 * change; `buildRuntimeInstructions` appends the block for the thread's
 * project to each provider's instructions, and the Pi launch passes it to its
 * extension.
 * Fork add-on: agent instructions.
 */
let environmentText = "";
let projectTexts: ReadonlyMap<string, string> = new Map();

export function setForkAgentInstructions(input: {
  readonly environment: string;
  readonly projects: ReadonlyMap<string, string>;
}): void {
  environmentText = input.environment.trim();
  projectTexts = input.projects;
}

/** The text for a project, falling back to the environment's. */
export function forkAgentInstructions(projectId?: string): string {
  return (projectId === undefined ? undefined : projectTexts.get(projectId)) ?? environmentText;
}

/** Empty when unset, otherwise a leading blank line plus the tagged block. */
export function forkAgentInstructionsBlock(projectId?: string): string {
  const text = forkAgentInstructions(projectId);
  if (text === "") return "";
  return `\n\n<t3_user_agent_instructions>\nThe user set these instructions in T3 Code for every agent it runs. When they conflict with instructions from CLAUDE.md, AGENTS.md, or other agent configuration files, follow these.\n\n${text}\n</t3_user_agent_instructions>`;
}
