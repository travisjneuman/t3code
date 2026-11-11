/**
 * The agents a source update tries, in order, when a merge conflicts or the merged build no
 * longer builds. A setting of one agent per line: `<agent> <model> <effort>`.
 * Fork add-on: upstream sync.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type RepairAgentKind = "pi" | "claude";

export interface RepairAgent {
  readonly agent: RepairAgentKind;
  /** Pi takes `provider/model`; Claude Code takes a model id or alias. */
  readonly model: string;
  readonly effort: string;
}

/** Pi on API keys first, then Claude Code on its own sign-in. */
export const DEFAULT_REPAIR_AGENTS = [
  "pi anthropic/claude-opus-5-5 medium",
  "pi openai/gpt-6.1-sol medium",
  "claude claude-opus-5-5 medium",
].join("\n");

const EFFORTS: Readonly<Record<RepairAgentKind, ReadonlySet<string>>> = {
  pi: new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  claude: new Set(["low", "medium", "high", "xhigh", "max"]),
};

/** The lines that name an agent, a model and an effort that agent accepts, in order. */
export const parseRepairAgents = (text: string): ReadonlyArray<RepairAgent> =>
  text.split("\n").flatMap((line): ReadonlyArray<RepairAgent> => {
    const [agent, model, effort, ...rest] = line.trim().split(/\s+/);
    if ((agent !== "pi" && agent !== "claude") || model === undefined || effort === undefined) {
      return [];
    }
    return rest.length === 0 && EFFORTS[agent].has(effort) ? [{ agent, model, effort }] : [];
  });

export const repairAgentLabel = ({ agent, model, effort }: RepairAgent): string =>
  `${agent === "pi" ? "Pi" : "Claude Code"} on ${model} (${effort})`;

/**
 * The agents to try, read from a settings file's text. The file holds only changed settings,
 * so text that is missing, unreadable or names no valid agent gives the default order.
 */
export const repairAgentsFromSettings = (settingsText: string): ReadonlyArray<RepairAgent> => {
  const defaults = parseRepairAgents(DEFAULT_REPAIR_AGENTS);
  try {
    const settings: unknown = JSON.parse(settingsText);
    if (typeof settings !== "object" || settings === null) return defaults;
    if (!("sourceUpdateRepairAgents" in settings)) return defaults;
    const value = settings.sourceUpdateRepairAgents;
    const agents = typeof value === "string" ? parseRepairAgents(value) : [];
    return agents.length > 0 ? agents : defaults;
  } catch {
    return defaults;
  }
};

export const RepairAgentsSettingsFields = {
  sourceUpdateRepairAgents: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_REPAIR_AGENTS)),
  ),
};

export const RepairAgentsSettingsPatchFields = {
  sourceUpdateRepairAgents: Schema.optionalKey(Schema.String),
};
