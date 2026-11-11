// @effect-diagnostics nodeBuiltinImport:off - a plain Node script, so it runs before `vp i` too.
// Fork add-on(core): applies fork/addons.config.json to the registries' generated regions and
// to FORK_ADDONS, and writes the landing page's add-on table from fork/addons.json. Run
// `node scripts/fork-addons.ts` after changing the config or the manifest, then rebuild.
// See docs/internals/fork-add-ons.md.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  CAPABILITIES_PATH,
  markerIds,
  readManifest,
  README_PATH,
  readRequestedAddOns,
  resolveAddOns,
  ROOT,
  selectionBlockers,
  selectRegions,
  withAddOnTable,
  withForkAddOns,
} from "./lib/fork-addons.ts";

const read = (path: string) => NodeFS.readFileSync(NodePath.join(ROOT, path), "utf8");

const manifest = readManifest();
const included = resolveAddOns(manifest, readRequestedAddOns());
const blockers = selectionBlockers(manifest, included, read);
if (blockers.length > 0) {
  console.error(
    `Nothing written. These add-ons cannot be left out yet:\n${blockers.map((line) => `  ${line}`).join("\n")}`,
  );
  process.exit(1);
}

const known = new Set(manifest.addons.map(({ id }) => id));
const registries = [...new Set(manifest.extensionPoints.map(({ registry }) => registry))];
const unknown = registries.flatMap((file) =>
  read(file)
    .split("\n")
    .flatMap((line, index) =>
      markerIds(line)
        .filter((id) => !known.has(id))
        .map((id) => `  ${file}:${index + 1} names unknown add-on "${id}"`),
    ),
);
if (unknown.length > 0) {
  console.error(`Nothing written. Fix these markers first:\n${unknown.join("\n")}`);
  process.exit(1);
}

let changed = 0;
for (const file of registries) {
  const before = read(file);
  const selected = selectRegions(before, included, "comment");
  const after =
    file === CAPABILITIES_PATH ? withForkAddOns(selected, manifest, included) : selected;
  if (after === before) continue;
  NodeFS.writeFileSync(NodePath.join(ROOT, file), after);
  changed += 1;
  console.log(`updated ${file}`);
}
// The landing page lists every add-on, whatever this build includes.
const readme = read(README_PATH);
const readmeWithTable = withAddOnTable(readme, manifest);
if (readmeWithTable !== readme) {
  NodeFS.writeFileSync(NodePath.join(ROOT, README_PATH), readmeWithTable);
  changed += 1;
  console.log(`updated ${README_PATH}`);
}
console.log(`${included.size} add-ons including core; ${changed} files changed.`);
