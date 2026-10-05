/**
 * Comparisons as lists: thread shells grouped by the pair they belong to, for
 * the start page's earlier and archived comparisons and the pair menu, plus
 * the title rules a comparison's threads follow. Fork add-on: compare agents.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { comparePairOf, type EnvironmentId } from "@t3tools/contracts";

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export interface ComparePair {
  readonly pairId: string;
  readonly prompt: string;
  /** Left then right; a side the list does not hold is missing. */
  readonly models: ReadonlyArray<string | undefined>;
  readonly at: string;
  readonly working: boolean;
  /** The sides this list holds, left first. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

const titleParts = (title: string): readonly [string, string] | null => {
  const parts = title.split(" · ");
  return parts[0] === "Compare" && parts.length >= 3
    ? [parts[1]!, parts.slice(2).join(" · ")]
    : null;
};

/** The comparison's name: a side's title without its `Compare · <model> ·` prefix. */
export const comparePromptOf = (title: string): string => titleParts(title)?.[1] ?? title;

/** A side's title after renaming the comparison to `name`, keeping its prefix. */
export const renamedCompareTitle = (title: string, name: string): string => {
  const parts = titleParts(title);
  return parts === null ? name : `Compare · ${parts[0]} · ${name}`;
};

/** The environment's comparisons among `shells`, newest activity first. */
export const groupComparePairs = (
  shells: ReadonlyArray<EnvironmentThreadShell>,
  environmentId: EnvironmentId,
): ReadonlyArray<ComparePair> => {
  const byPair = new Map<string, { pair: ComparePair; sides: EnvironmentThreadShell[] }>();
  for (const shell of shells) {
    if (shell.environmentId !== environmentId) continue;
    const side = comparePairOf(shell.id);
    if (side === null) continue;
    const entry = byPair.get(side.pairId) ?? {
      pair: {
        pairId: side.pairId,
        prompt: comparePromptOf(shell.title),
        models: [],
        at: shell.createdAt,
        working: false,
        threads: [],
      },
      sides: [],
    };
    const models = [...entry.pair.models];
    models[side.side === "a" ? 0 : 1] = shell.modelSelection.model;
    if (side.side === "a") entry.sides.unshift(shell);
    else entry.sides.push(shell);
    const at = shell.updatedAt > entry.pair.at ? shell.updatedAt : entry.pair.at;
    entry.pair = {
      ...entry.pair,
      // The left side's title names the comparison when both are present.
      prompt: side.side === "a" ? comparePromptOf(shell.title) : entry.pair.prompt,
      models,
      at,
      working: entry.pair.working || ACTIVE_RUN_STATUSES.has(shell.latestRun?.status ?? ""),
      threads: entry.sides,
    };
    byPair.set(side.pairId, entry);
  }
  return [...byPair.values()]
    .map(({ pair }) => pair)
    .toSorted((left, right) => right.at.localeCompare(left.at));
};
