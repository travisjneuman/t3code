// The fork renames the product text across docs, tests, and strings. Those
// renames collide with nearly every upstream edit to the same lines, so a
// plain `git merge` stops on conflicts that carry no real fork intent.
//
// A conflicted file is resolved automatically only when the fork's entire
// change to it is the rename: applying the rename to the merge base must
// reproduce the fork's side exactly. The upstream side is then taken and the
// same rename applied to it, which keeps every upstream edit and every fork
// rename. Any other fork change leaves the conflict for a human.

const FORK_RENAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/T3 Code/g, "ndev.t3code"],
  [/T3-Code/g, "ndev.t3code"],
];

export const applyForkRenames = (text: string): string =>
  FORK_RENAMES.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);

// The rename is followed by a formatter pass, which can rewrap the renamed
// lines. Layout-only differences are not fork intent.
const withoutWhitespace = (text: string): string => text.replace(/\s+/g, "");

export interface ConflictSides {
  readonly base: string | null;
  readonly ours: string | null;
  readonly theirs: string | null;
}

export type ConflictResolution =
  | { readonly kind: "write"; readonly contents: string }
  | { readonly kind: "delete" };

/**
 * Resolves a conflict whose fork side differs from the merge base only by the
 * product rename. Upstream deletions win; upstream edits are kept and renamed.
 * Returns null when a human must resolve it.
 */
export const resolveRenameOnlyConflict = (sides: ConflictSides): ConflictResolution | null => {
  if (sides.base === null || sides.ours === null) return null;
  if (withoutWhitespace(applyForkRenames(sides.base)) !== withoutWhitespace(sides.ours)) return null;
  if (sides.theirs === null) return { kind: "delete" };
  return { kind: "write", contents: applyForkRenames(sides.theirs) };
};

const isMarker = (line: string, marker: string): boolean =>
  line === marker || line.startsWith(`${marker} `);

/**
 * Resolves rename-only hunks inside a file written with diff3 conflict markers
 * (`git checkout --conflict=diff3`). Hunks with other fork changes keep their
 * markers. Returns the new contents and how many hunks still need a human.
 */
export const resolveRenameOnlyHunks = (
  text: string,
): { readonly contents: string; readonly unresolved: number } => {
  const lines = text.split("\n");
  const output: Array<string> = [];
  let unresolved = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!isMarker(line, "<<<<<<<")) {
      output.push(line);
      index += 1;
      continue;
    }
    const start = index;
    const ours: Array<string> = [];
    const base: Array<string> = [];
    const theirs: Array<string> = [];
    let section: "ours" | "base" | "theirs" = "ours";
    let closed = false;
    index += 1;
    while (index < lines.length) {
      const current = lines[index]!;
      index += 1;
      if (section === "ours" && isMarker(current, "|||||||")) section = "base";
      else if (section !== "theirs" && current === "=======") section = "theirs";
      else if (section === "theirs" && isMarker(current, ">>>>>>>")) {
        closed = true;
        break;
      } else (section === "ours" ? ours : section === "base" ? base : theirs).push(current);
    }
    const resolved =
      closed && section === "theirs"
        ? resolveRenameOnlyConflict({
            base: base.join("\n"),
            ours: ours.join("\n"),
            theirs: theirs.join("\n"),
          })
        : null;
    if (resolved?.kind === "write") {
      if (theirs.length > 0) output.push(resolved.contents);
    } else {
      unresolved += 1;
      output.push(...lines.slice(start, index));
    }
  }
  return { contents: output.join("\n"), unresolved };
};
