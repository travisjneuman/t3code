// Fork add-on(core): reads fork/addons.json and the build's add-on selection, and filters the
// registries' generated regions. Used by scripts/fork-addons.ts and scripts/fork-addons-export.ts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const ROOT = NodePath.resolve(import.meta.dirname, "..", "..");
export const MANIFEST_PATH = "fork/addons.json";
export const CONFIG_PATH = "fork/addons.config.json";
/** Keeps every entry in every build: the migrator skips ids below the highest one run. */
export const MIGRATIONS_REGISTRY = "apps/server/src/persistence/ForkMigrations.ts";

const REGION_BEGIN = "fork-addons:begin";
const REGION_END = "fork-addons:end";
/** A region the export filters but the in-tree build keeps whole (contracts, settings). */
const EXPORT_ONLY = "export only";
const OFF = "// fork-addons:off ";
const MARKER = /Fork add-on\(([^)]*)\)/g;
export const CAPABILITIES_PATH = "packages/contracts/src/forkCapabilities.ts";
/** The public landing page, whose add-on table is written from the manifest. */
export const README_PATH = ".github/README.md";
const README_TABLE =
  /(<!-- fork-addons:table:begin -->\n\n)[\s\S]*?(\n\n<!-- fork-addons:table:end -->)/;
const FORK_ADDONS = /export const FORK_ADDONS = \[[^\]]*\] as const;/;
/** A multi-line import or export whose every name was dropped. */
const EMPTY_SPECIFIERS = /^[ \t]*(?:import|export)(?: type)? \{\n[ \t]*\} from [^\n]*\n/gm;

export interface AddOn {
  readonly id: string;
  readonly tier: string;
  readonly title: string;
  readonly summary: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
  readonly tests?: ReadonlyArray<string>;
  readonly hooks: ReadonlyArray<string>;
  readonly unmarkedUpstreamEdits?: Readonly<Record<string, string>>;
  readonly upstreamDeletions?: ReadonlyArray<{ readonly file: string; readonly line: string }>;
}

export interface Manifest {
  readonly extensionPoints: ReadonlyArray<{
    readonly name: string;
    readonly registry: string;
    readonly addons: ReadonlyArray<string>;
  }>;
  readonly addons: ReadonlyArray<AddOn>;
}

const readJson = (path: string): unknown =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(ROOT, path), "utf8"));

export const readManifest = () => readJson(MANIFEST_PATH) as Manifest;

/** The ids fork/addons.config.json asks for: "all", or a list. */
export function readRequestedAddOns(): "all" | ReadonlyArray<string> {
  const config = readJson(CONFIG_PATH);
  const addons =
    typeof config === "object" && config !== null && "addons" in config ? config.addons : null;
  if (addons === "all") return "all";
  if (Array.isArray(addons) && addons.every((id) => typeof id === "string")) return addons;
  throw new Error(`${CONFIG_PATH}: "addons" must be "all" or a list of add-on ids.`);
}

/** core, the requested add-ons, and everything they depend on. Unknown ids are an error. */
export function resolveAddOns(
  manifest: Manifest,
  requested: "all" | ReadonlyArray<string>,
): ReadonlySet<string> {
  const byId = new Map(manifest.addons.map((addOn) => [addOn.id, addOn]));
  const ids = requested === "all" ? [...byId.keys()] : requested;
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown add-on ids: ${unknown.join(", ")}. The ids are in ${MANIFEST_PATH}.`);
  }
  const selected = new Set<string>();
  const add = (id: string) => {
    if (selected.has(id)) return;
    selected.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) add(dependency);
  };
  add("core");
  for (const id of ids) add(id);
  return selected;
}

/** The ids in manifest order, each after the add-ons it depends on. */
export function dependencyOrder(manifest: Manifest, ids: ReadonlySet<string>): string[] {
  const byId = new Map(manifest.addons.map((addOn) => [addOn.id, addOn]));
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || !ids.has(id)) return;
    seen.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    order.push(id);
  };
  for (const addOn of manifest.addons) visit(addOn.id);
  return order;
}

/** forkCapabilities.ts with FORK_ADDONS listing the included ids, laid out as the formatter would. */
export function withForkAddOns(text: string, manifest: Manifest, included: ReadonlySet<string>) {
  if (!FORK_ADDONS.test(text)) throw new Error(`${CAPABILITIES_PATH} has no FORK_ADDONS array.`);
  const items = manifest.addons
    .filter(({ id }) => included.has(id))
    .map(({ id }) => JSON.stringify(id));
  const oneLine = `export const FORK_ADDONS = [${items.join(", ")}] as const;`;
  const array =
    oneLine.length <= 100
      ? oneLine
      : `export const FORK_ADDONS = [\n${items.map((item) => `  ${item},\n`).join("")}] as const;`;
  return text.replace(FORK_ADDONS, () => array);
}

export const markerIds = (line: string) =>
  [...line.matchAll(MARKER)].flatMap((match) => (match[1] ?? "").split(",").map((id) => id.trim()));

export const hasRegions = (text: string) => text.includes(REGION_BEGIN);

/**
 * Applies a selection to a registry's regions. A marked line stays when any of its ids is
 * included; otherwise it is commented out with a fixed prefix ("comment", in tree, so the marker
 * count never changes) or removed ("drop", for the export). Comment lines directly above a
 * marked line go with it. Lines a previous run commented out are restored first.
 */
export function selectRegions(
  text: string,
  included: ReadonlySet<string>,
  mode: "comment" | "drop",
): string {
  const out: string[] = [];
  let region: "none" | "toggled" | "exportOnly" = "none";
  let pending: string[] = [];
  const emit = (lines: ReadonlyArray<string>, keep: boolean) => {
    for (const line of lines) {
      if (keep) out.push(line);
      else if (mode === "comment") {
        const body = line.trimStart();
        out.push(line.slice(0, line.length - body.length) + OFF + body);
      }
    }
  };
  for (const raw of text.split("\n")) {
    if (raw.includes(REGION_BEGIN) || raw.includes(REGION_END)) {
      emit(pending, true);
      pending = [];
      region = raw.includes(REGION_END)
        ? "none"
        : raw.includes(EXPORT_ONLY)
          ? "exportOnly"
          : "toggled";
      out.push(raw);
      continue;
    }
    const body = raw.trimStart();
    const line = body.startsWith(OFF)
      ? raw.slice(0, raw.length - body.length) + body.slice(OFF.length)
      : raw;
    const filtered = region === "toggled" || (region === "exportOnly" && mode === "drop");
    const ids = filtered ? markerIds(line) : [];
    if (ids.length > 0) {
      const keep = ids.some((id) => included.has(id));
      emit(pending, keep);
      emit([line], keep);
      pending = [];
    } else if (filtered && /^\s*(\/\/|\/\*|\*)/.test(line)) {
      pending.push(line);
    } else {
      emit(pending, true);
      emit([line], true);
      pending = [];
    }
  }
  emit(pending, true);
  const result = out.join("\n");
  return mode === "drop" ? result.replace(EMPTY_SPECIFIERS, "") : result;
}

/**
 * Why each left-out add-on cannot be left out by the registries alone: an upstream file still
 * calls it, or a registry without a generated region still registers it.
 */
export function selectionBlockers(
  manifest: Manifest,
  included: ReadonlySet<string>,
  readFile: (path: string) => string,
): string[] {
  const blockers: string[] = [];
  const unfiltered = manifest.extensionPoints.filter(
    ({ registry }) => registry !== MIGRATIONS_REGISTRY && !hasRegions(readFile(registry)),
  );
  for (const addOn of manifest.addons) {
    if (included.has(addOn.id)) continue;
    const where = [
      ...addOn.hooks.map((file) => `hook in ${file}`),
      ...Object.keys(addOn.unmarkedUpstreamEdits ?? {}).map((file) => `unmarked edit to ${file}`),
      ...(addOn.upstreamDeletions ?? []).map(({ file }) => `deleted line in ${file}`),
      ...unfiltered
        .filter(({ addons }) => addons.includes(addOn.id))
        .map(({ registry }) => `registered in ${registry}, which has no generated region`),
    ];
    for (const reason of new Set(where)) blockers.push(`${addOn.id}: ${reason}`);
  }
  return blockers;
}

/** GitHub's anchor for a heading: lowercase, punctuation dropped, spaces to hyphens. */
const headingAnchor = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");

/**
 * The landing page with its add-on table rewritten from the manifest, one row per add-on in
 * manifest order, so the table cannot drift from it. A title links to its section when the
 * page has a `###` heading of the same name. Columns are padded the way the formatter pads them.
 */
export const withAddOnTable = (readme: string, manifest: Manifest): string => {
  const headings = new Set(
    readme.split("\n").flatMap((line) => (line.startsWith("### ") ? [line.slice(4).trim()] : [])),
  );
  const rows = [
    ["Id", "Tier", "Add-on", "What it does"],
    ...manifest.addons.map(({ id, tier, title, summary }) => [
      `\`${id}\``,
      tier,
      headings.has(title) ? `[${title}](#${headingAnchor(title)})` : title,
      summary.replace(/\|/g, "\\|"),
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  const line = (cells: ReadonlyArray<string>) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ")} |`;
  const table = [
    line(rows[0]!),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.slice(1).map(line),
  ].join("\n");
  return readme.replace(README_TABLE, (_, begin: string, end: string) => `${begin}${table}${end}`);
};
