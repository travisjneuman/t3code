// @effect-diagnostics nodeBuiltinImport:off - a plain Node script that only reads git.
// Fork add-on(core): writes core and each chosen add-on as patches against upstream, one per
// add-on, applied in order. See docs/internals/fork-add-ons.md.
//
//   node scripts/fork-addons-export.ts [--out <dir>] [--base <commit>] [<id> ...]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  CAPABILITIES_PATH,
  dependencyOrder,
  hasRegions,
  markerIds,
  MIGRATIONS_REGISTRY,
  readManifest,
  readRequestedAddOns,
  resolveAddOns,
  ROOT,
  selectRegions,
  withForkAddOns,
} from "./lib/fork-addons.ts";

function git(args: ReadonlyArray<string>, cwd = ROOT): Buffer {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, maxBuffer: 1 << 30 });
  // `diff --no-index` exits 1 when the files differ.
  if (result.status !== 0 && !(args.includes("--no-index") && result.status === 1)) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr.toString()}`);
  }
  return result.stdout;
}
const gitText = (args: ReadonlyArray<string>) => git(args).toString("utf8");

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} needs a value.`);
  args.splice(index, 2);
  return value;
};
const outDir = NodePath.resolve(option("--out") ?? NodePath.join(ROOT, "release", "fork-addons"));
const head = gitText(["rev-parse", "HEAD"]).trim();
const base = gitText(["merge-base", head, option("--base") ?? "upstream/main"]).trim();

const manifest = readManifest();
const known = new Set(manifest.addons.map(({ id }) => id));
const chosen = resolveAddOns(manifest, args.length > 0 ? args : readRequestedAddOns());
const steps = dependencyOrder(manifest, chosen);
const warnings = new Set<string>();
const ownIds = (line: string) => markerIds(line).filter((id) => known.has(id));

const owner = new Map<string, string>();
for (const addOn of manifest.addons) {
  for (const file of [...addOn.files, ...(addOn.tests ?? [])]) owner.set(file, addOn.id);
}
const wholeFile = new Map<string, string[]>();
const deletions = new Map<string, Array<{ readonly line: string; readonly id: string }>>();
for (const addOn of manifest.addons) {
  for (const file of Object.keys(addOn.unmarkedUpstreamEdits ?? {})) {
    wholeFile.set(file, [...(wholeFile.get(file) ?? []), addOn.id]);
  }
  for (const { file, line } of addOn.upstreamDeletions ?? []) {
    deletions.set(file, [...(deletions.get(file) ?? []), { line: line.trim(), id: addOn.id }]);
  }
}

const show = (commit: string, file: string) => git(["show", `${commit}:${file}`]);
const isBinary = (content: Buffer) => content.includes(0);
const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

interface OwnedLine {
  text: string;
  ids: ReadonlyArray<string>;
}

interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly removed: OwnedLine[];
  readonly added: OwnedLine[];
}

/** The file's -U0 hunks, each line owned by the add-on ids its marker (or a neighbour's) names. */
function ownedHunks(file: string): Hunk[] {
  const diff = gitText([
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    base,
    head,
    "--",
    file,
  ]);
  const hunks: Hunk[] = [];
  let last: OwnedLine | undefined;
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (header) {
      hunks.push({
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        removed: [],
        added: [],
      });
      continue;
    }
    const hunk = hunks.at(-1);
    if (!hunk) continue;
    if (line.startsWith("\\")) {
      if (last) last.text = last.text.replace(/\n$/, "");
    } else if (line.startsWith("-") || line.startsWith("+")) {
      last = { text: `${line.slice(1)}\n`, ids: [] };
      (line.startsWith("-") ? hunk.removed : hunk.added).push(last);
    }
  }
  const marked = hunks.map((hunk) => hunk.added.flatMap(({ text }) => ownIds(text)));
  const nearest = (index: number) => {
    for (let distance = 1; distance < hunks.length; distance += 1) {
      const before = marked[index - distance];
      if (before && before.length > 0) return before.slice(0, 1);
      const after = marked[index + distance];
      if (after && after.length > 0) return after.slice(0, 1);
    }
    warnings.add(`${file}: hunks with no marker are attributed to core.`);
    return ["core"];
  };
  hunks.forEach((hunk, index) => {
    const fallback = marked[index]?.length ? undefined : nearest(index);
    // An unmarked line in a marked hunk belongs to the marked line above it, else below it.
    const lineIds = hunk.added.map(({ text }) => ownIds(text));
    for (const [position, line] of hunk.added.entries()) {
      const ids = lineIds[position] ?? [];
      const above = lineIds.slice(0, position).findLast((found) => found.length > 0);
      const below = lineIds.slice(position + 1).find((found) => found.length > 0);
      line.ids = ids.length > 0 ? ids : (above ?? below ?? fallback ?? []);
    }
    const firstMarked = hunk.added.find((line) => ownIds(line.text).length > 0);
    for (const line of hunk.removed) {
      const deletion = deletions.get(file)?.find(({ line: text }) => text === line.text.trim());
      line.ids = deletion
        ? [deletion.id]
        : firstMarked
          ? ownIds(firstMarked.text).slice(0, 1)
          : (fallback ?? []);
    }
  });
  return hunks;
}

/** Base with the hunk lines whose owners are included: removals applied, additions kept. */
function applyHunks(baseText: string, hunks: ReadonlyArray<Hunk>, included: ReadonlySet<string>) {
  const lines = splitLines(baseText);
  const out: string[] = [];
  const keep = (ids: ReadonlyArray<string>) => ids.some((id) => included.has(id));
  let next = 0;
  for (const hunk of hunks) {
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    out.push(...lines.slice(next, start));
    for (const line of hunk.removed) if (!keep(line.ids)) out.push(line.text);
    for (const line of hunk.added) if (keep(line.ids)) out.push(line.text);
    next = start + hunk.oldCount;
  }
  out.push(...lines.slice(next));
  return out.join("");
}

interface Change {
  readonly status: string;
  readonly file: string;
}
const nameStatus = gitText(["diff", "--name-status", "-z", "--no-renames", base, head]).split(
  "\0",
);
const changes: Change[] = [];
for (let index = 0; index + 1 < nameStatus.length; index += 2) {
  changes.push({ status: nameStatus[index] ?? "", file: nameStatus[index + 1] ?? "" });
}
const modes = new Map(
  gitText(["ls-tree", "-r", "-z", head])
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [meta = "", file = ""] = entry.split("\t");
      return [file, meta.split(" ")[0] ?? ""] as const;
    }),
);

const cache = new Map<string, Buffer>();
const cached = (key: string, read: () => Buffer) => {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = read();
  cache.set(key, value);
  return value;
};
const hunkCache = new Map<string, Hunk[]>();

/** Migrations ship with core: an id left out now would be skipped forever once a later id ran. */
const MIGRATIONS_DIR = MIGRATIONS_REGISTRY.replace(/\.ts$/, "/");

function addedFileOwner(file: string) {
  if (file.startsWith("fork/") || file.startsWith(MIGRATIONS_DIR)) return "core";
  const id = owner.get(file);
  if (id === undefined) warnings.add(`${file}: not listed in fork/addons.json; exported with core.`);
  return id ?? "core";
}

/** The file with exactly the included add-ons, or null when it does not exist then. */
function contentFor(change: Change, included: ReadonlySet<string> | "upstream"): Buffer | null {
  const { status, file } = change;
  const upstream = () => (status === "A" ? null : cached(`base:${file}`, () => show(base, file)));
  if (included === "upstream") return upstream();
  const fork = () => cached(`head:${file}`, () => show(head, file));
  if (status === "D") return null;
  if (status === "A") {
    if (!included.has(addedFileOwner(file))) return null;
    const content = fork();
    if (isBinary(content)) return content;
    const text = content.toString("utf8");
    if (!hasRegions(text)) return content;
    const selected = selectRegions(text, included, "drop");
    return Buffer.from(
      file === CAPABILITIES_PATH ? withForkAddOns(selected, manifest, included) : selected,
    );
  }
  const listed = wholeFile.get(file);
  if (listed) return listed.some((id) => included.has(id)) ? fork() : upstream();
  const before = upstream();
  if (before === null || isBinary(before) || isBinary(fork())) return fork();
  const hunks = hunkCache.get(file) ?? ownedHunks(file);
  hunkCache.set(file, hunks);
  return Buffer.from(applyHunks(before.toString("utf8"), hunks, included));
}

// Registries without generated regions are exported whole, with every add-on they register.
const wholeRegistries = manifest.extensionPoints.filter(
  ({ registry }) =>
    registry !== MIGRATIONS_REGISTRY && !hasRegions(show(head, registry).toString("utf8")),
);
for (const { registry, addons } of wholeRegistries) {
  const missing = addons.filter((id) => !chosen.has(id));
  if (missing.length > 0) {
    warnings.add(`${registry} has no generated region and still registers ${missing.join(", ")}.`);
  }
}

if (NodeFS.existsSync(outDir) && NodeFS.readdirSync(outDir).length > 0) {
  throw new Error(`${outDir} is not empty; pass --out with a new or empty directory.`);
}
NodeFS.mkdirSync(outDir, { recursive: true });
const work = NodePath.join(outDir, ".work");
const byId = new Map(manifest.addons.map((addOn) => [addOn.id, addOn]));
const current = new Map(changes.map((change) => [change.file, contentFor(change, "upstream")]));
let written = 0;
try {
  for (const [index, id] of steps.entries()) {
    const included: ReadonlySet<string> = new Set(steps.slice(0, index + 1));
    NodeFS.rmSync(work, { recursive: true, force: true });
    for (const side of ["a", "b"]) NodeFS.mkdirSync(NodePath.join(work, side), { recursive: true });
    let files = 0;
    for (const change of changes) {
      const before = current.get(change.file) ?? null;
      const after = contentFor(change, included);
      current.set(change.file, after);
      if (before === after || (before && after && before.equals(after))) continue;
      files += 1;
      for (const [side, content] of [
        ["a", before],
        ["b", after],
      ] as const) {
        if (content === null) continue;
        const target = NodePath.join(work, side, change.file);
        NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
        NodeFS.writeFileSync(target, content);
        if (modes.get(change.file) === "100755") NodeFS.chmodSync(target, 0o755);
      }
    }
    if (files === 0) {
      console.log(`${id}: no changes of its own, so no patch.`);
      continue;
    }
    const patch = git(
      ["diff", "--no-index", "--no-prefix", "--binary", "--no-color", "--no-ext-diff", "a", "b"],
      work,
    );
    const name = `${String(index).padStart(2, "0")}-${id}.patch`;
    const header =
      `Fork add-on ${id} (${byId.get(id)?.tier ?? "unknown"}) against upstream ${base}.\n` +
      `Apply with \`git apply\` after the patches numbered before it.\n\n`;
    NodeFS.writeFileSync(NodePath.join(outDir, name), Buffer.concat([Buffer.from(header), patch]));
    written += 1;
    console.log(`${name}: ${files} files`);
  }
} finally {
  NodeFS.rmSync(work, { recursive: true, force: true });
}
for (const warning of warnings) console.warn(`warning: ${warning}`);
console.log(`Wrote ${written} patches for ${head.slice(0, 10)} to ${outDir}.`);
