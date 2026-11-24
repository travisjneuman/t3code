# Fork add-ons

ndev.t3code is upstream T3 Code plus add-ons. It merges upstream continually and never pushes or
opens pull requests upstream, so every upstream merge costs less the less the fork touches upstream
files. That is why the fork is shaped like a plug-in rather than a patch set.

## Fork-owned files and hooks

- Fork features live in fork-owned files: files that do not exist in `upstream/main`. They can
  change freely; upstream merges never conflict with them.
- An upstream file gets only one-line hooks at stable points that call into fork-owned code: an
  import, a spread into a list or layer, a mount. A hook is one line so a conflict on it is
  obvious and quick to re-apply.
- Every fork code line in an upstream file carries `Fork add-on(<id>)` inline, usually as a
  trailing comment, where `<id>` names its add-on in [`fork/addons.json`](../../fork/addons.json).
  A line shared by several add-ons lists them comma-separated: `Fork add-on(thread-export,save-to-notes)`.
  An explanation follows a colon: `Fork add-on(hermes): Hermes reports its full catalog`. A
  multi-line fork comment is marked once on its first line. `git grep -n "Fork add-on("` lists the
  whole fork footprint in upstream files, `git grep -n "Fork add-on(hermes"` one add-on's, and a
  fork change to an upstream file without the marker is a bug.
- JSON and binary assets cannot hold comments, and generated files cannot retain hand-added
  markers reliably. The [exceptions](#marker-exceptions) are not protected by the marker check;
  review their fork diff explicitly during upstream sync. Keep those edits to what a feature cannot
  do without.
- Upstream docs stay identical to `upstream/main`. Fork documentation is in fork-owned pages under
  `docs/`, and the repository landing page is `.github/README.md`. When the fork changes how an
  upstream feature behaves, say so in [`fork-behavior.md`](../user/fork-behavior.md), not in the
  upstream guide.

## Footprint

Measured against `67c442a17e`, the upstream commit merged as nightly
`v0.1.12-nightly.20261123.5165`. Line counts move with every fork commit; recompute them rather
than trust them.

| What                                      | Count                                                       |
| ----------------------------------------- | ----------------------------------------------------------- |
| Add-ons in the manifest                   | 55 (1 core, 35 feature, 12 fix, 5 distribution, 2 personal) |
| Fork-owned files                          | 423 files, about 74,700 lines                               |
| Upstream files the fork changes           | 227 files, +3,177 / −716 lines                              |
| Of those, carrying `Fork add-on(` markers | 205 files, 1,792 marker lines                               |
| Of those, without a marker                | 22: the [exceptions](#marker-exceptions)                    |
| Upstream files the fork deletes           | 0                                                           |

Recompute against the current merge-base (the `upstream` remote must exist):

```sh
base=$(git merge-base HEAD upstream/main)
git diff --shortstat "$base" HEAD --diff-filter=A   # fork-owned files
git diff --shortstat "$base" HEAD --diff-filter=M   # changed upstream files
git diff --name-only "$base" HEAD --diff-filter=M | xargs git grep -l "Fork add-on(" HEAD -- | wc -l
git diff --name-only "$base" HEAD --diff-filter=M | xargs git grep -h "Fork add-on(" HEAD -- | wc -l
```

`git grep -c "Fork add-on(" HEAD` counts every tracked file, fork-owned registries and docs
included, so it reads higher than the upstream-file count.

## Add-on manifest

[`fork/addons.json`](../../fork/addons.json) lists every add-on: its id, tier, fork-owned `files`
and `tests`, the upstream files it `hooks` (the files where its markers are), the upstream edits
that cannot carry a marker, the upstream lines it deletes outright, the data it adds (migrations,
wire fields, settings), and `dependsOn`, the add-ons whose fork-owned files it imports. Every
fork-owned file outside `fork/` is listed in exactly one add-on; `fork/` itself belongs to `core`.
Tiers:

- `core`: plumbing the other add-ons hook into: the extension-point registries below and the fork
  migration ledger. `core` depends on no add-on.
- `feature`: a user-visible feature.
- `fix`: a small behavior fix to upstream code.
- `distribution`: how the fork is named, built, installed and updated, including upstream sync
  and host builds.
- `personal`: the owner's own host tooling and instructions; skip these when adopting add-ons.

No add-on changes the mobile app. Fork wire additions are optional fields that upstream clients,
mobile included, ignore.

`node scripts/fork-addons.ts` writes the add-on table in [`.github/README.md`](../../.github/README.md)
from the manifest, between its `fork-addons:table` comments, so edit a title or summary in the
manifest and never in the table. A title links to the landing page's `###` section of the same
name. Each add-on's `upstream` says what upstream has for the same need today and fills the
table's last column: re-read it for the add-ons whose hooked files an upstream merge touched, and
retire an add-on once upstream covers it.

The manifest is maintained by hand. A new add-on gets an entry and an id before its first marker,
and the entry changes in the same commit as the code: a new fork-owned file goes into one add-on's
`files` or `tests`, and a new hooked upstream file into its `hooks`. Nothing in the repository
checks this today (see [build-out status](#build-out-status)), so a file missing from the manifest
is found only by review or by the exporter's warnings.

A registry importing an add-on registers it, so those imports are not counted in `dependsOn`. What
is left is one-way: `core` depends on nothing, and no two add-ons depend on each other. Keeping an
add-on means keeping everything in its `dependsOn`, transitively: `host-releases` needs
`upstream-sync`, which needs `maintenance-queue`, which needs `hermes`.

## Extension points

Where several add-ons plug into the same upstream spot, the spot gets one fork-owned `core`
registry and the upstream file hooks it once, marked `Fork add-on(core)`. Adding or dropping an
add-on there edits the registry, not the upstream file. `extensionPoints` in
[`fork/addons.json`](../../fork/addons.json) lists all 25 with the registry file, the upstream file
that hooks it, and the add-ons registered there. They cover the contracts barrel and wire
(exports, RPC definitions, capability flags, settings, client RPC guards), the server (RPC
handlers, scopes, span labels, background workers, orchestration services, session-insights
readers, fork migrations), the web client (root hosts, fallback slots, composer banners, thread
menu, context menu icons, archived page, own-workspace drivers), the desktop shell (IPC, preload,
layers, menu, window) and the desktop artifact build.

- Each registry entry carries its add-on's id, `// Fork add-on(<id>)`, as in upstream files.
- A registry imports its add-ons' modules. A `core` file that imports a feature any other way
  shows up in `core`'s `dependsOn` and should move behind a registry. A registry that needs
  upstream-private values, such as the layers `runtimeLayer.ts` builds, takes them as
  arguments, as [`forkRuntimeLayers.ts`](../../apps/server/src/orchestration-v2/forkRuntimeLayers.ts)
  does.
- A spot only one add-on uses keeps that add-on's own marked hook, since a registry would add a
  file without removing a line.
- When one feature would import another add-on to extend it, the feature gets a registry instead
  and hooks it from its own file. Session details reads Hermes's own store through
  `forkInsightsReaders.ts` and asks `forkOwnWorkspaceDrivers.ts` which drivers keep their own
  workspace. A type the registrants share stays in the feature, and they import it as a type.
- A new add-on that plugs into an existing spot adds a registry entry. One that needs a new shared
  spot adds a registry and its `extensionPoints` entry in the same change.

### Fork migrations

[`ForkMigrations.ts`](../../apps/server/src/persistence/ForkMigrations.ts) keeps its own ledger
table, `fork_sql_migrations`, instead of adding to upstream's migration list. Upstream's migrator
skips every id at or below the highest it has recorded, so a fork id in its list would mask a
future upstream one. Fork migrations touch only fork-owned tables, which upstream builds sharing `~/.t3` ignore.
Fork-owned services that need a table run the ledger before they touch it. Every entry stays in
every build: a migration left out of one build would never run once a later build adds its add-on
back.

## Choosing add-ons

[`fork/addons.config.json`](../../fork/addons.config.json) names the add-ons a build compiles in:
`"addons": "all"` (the default) or a list of ids. `core` and each chosen add-on's `dependsOn` are
always added, and an unknown id is an error.

- `node scripts/fork-addons.ts` applies the config to the registries' generated regions, the lines
  between `// fork-addons:begin` and `// fork-addons:end`. A marked line in a region whose add-ons
  were all left out is commented out with a `// fork-addons:off ` prefix, together with the
  comment lines directly above it, and a later run restores it. Marker counts never change, so
  the upstream sync marker check is unaffected. It also writes `FORK_ADDONS` in
  [`forkCapabilities.ts`](../../packages/contracts/src/forkCapabilities.ts) and the README table.
  Commit its output with the config. The selection is compiled in: changing it needs a rebuild of
  every surface.
- A region marked `fork-addons:begin export only` (the contracts barrel, the settings fields, the
  capability fields, the desktop artifact hooks) is kept whole in the tree, so stored settings
  and wire fields still decode, and is filtered only by the exporter below.
- Fork migrations are never left out (see above). Before leaving out an add-on whose migration a
  database already ran, check by hand that the server is safe without it: its tables and columns
  stay, nothing drops them, and no remaining code may depend on what it migrated.
- An add-on can be left out in the tree only when nothing outside a generated region still calls
  it. Hooks in upstream files, unmarked upstream edits, deleted upstream lines and registrations in
  the eight registries without a region (the composer banners, the thread menu, the context menu
  icons, and the five desktop registries) all block it; the script then writes nothing and lists
  the blockers. Today every add-on but `core` has such a hook, so the in-tree build is always
  `all`, and a subset can only come from the exported patches.

The server advertises the ids it was built with as the optional `forkAddOns` server capability,
which upstream clients ignore, and web Settings › About shows them as "Fork add-ons". An upstream
server sends none and the row is hidden.

`node scripts/fork-addons-export.ts [--out <dir>] [--base <commit>] [<id> ...]` writes `core` and
each chosen add-on (the config's choice when no ids are given) as one patch each against the
merge-base of `HEAD` and `upstream/main` (or `--base`), numbered in dependency order:
`00-core.patch`, then each add-on, each applied with `git apply` after the ones before it. Without
`--base` it needs an `upstream` remote. The output defaults to the gitignored
`release/fork-addons/` and must be new or empty. It reads only committed `HEAD`, with read-only git
commands.

- A fork-owned file goes to the add-on listing it, migrations and `fork/` to `core`, and a file no
  add-on lists to `core` with a warning. Generated regions are filtered by marker, empty import or
  export statements left behind are removed, and `FORK_ADDONS` lists the add-ons applied so far.
- In an upstream file, each added line goes to its marker's add-ons, an unmarked line to the
  nearest marked line in its hunk (above first), and a hunk with no marker to the nearest marked
  hunk, else `core`. A removed line goes to the add-on whose `upstreamDeletions` name it, else to
  the hunk's first marker. Files in `unmarkedUpstreamEdits` move whole, with their first chosen
  add-on. The translation catalogs are in no add-on's list and hold no marker, so all their fork
  strings go to `core`. The exporter prints a warning for each guess it falls back on.
- Registries without a generated region are exported whole and so still register every add-on.
  The exporter warns about each, and the result needs those entries removed by hand before it
  compiles.

## Build-out status

The plug-in shape was built in steps: a plug-in refactor, then phases 0 to 5. Each is listed with
what it established and whether it holds today.

- **Plug-in refactor.** Text and identity moved out of upstream files. The fork had been a rebrand
  touching 325 upstream files, mostly renamed strings; afterwards it touched 50 upstream files
  through 168 marked lines, with features in fork-owned files. Identity shrank to the
  [two files below](#identity), upstream's tests were restored, and server state went back to
  `~/.t3`. Done.
- **Phase 0, ids and manifest.** Every marker names an add-on id, and `fork/addons.json` lists
  each add-on's files, hooks and data. Done.
- **Phase 1, a registry per extension point.** Shared upstream spots are hooked once and fan out
  through `core` registries. Done.
- **Phase 2, a fork core with no add-on dependencies.** `core` depends on nothing, `dependsOn` is
  acyclic, fork migrations got their own ledger, and the desktop bridge was split per add-on.
  Done.
- **Phase 3, fallback slots and full attribution.** Replaced upstream UI blocks became
  [fallback slots](#fallback-slots), and every upstream hunk became
  [attributed](#every-upstream-change-is-attributed). Done.
- **Phase 4, build-time selection.** The selection config, `scripts/fork-addons.ts`, the
  `forkAddOns` capability and its Settings row, and the per-add-on exporter exist and work as
  described above. Not done: an in-tree build of a subset is impossible while every add-on has a
  hook outside a generated region, and no exported subset has been applied to a clean upstream
  and built, so the exporter's ownership guesses are unproven.
- **Phase 5, governance.** Not started. Nothing generates the manifest or checks it against the
  tree. The only automatic checks are `scripts/fork-addons.ts` refusing to write when a registry
  marker names an unknown id, and the exporter's warnings. The upstream sync's
  [marker check](#marker-check-during-upstream-sync) counts markers per file without reading the
  manifest. The phase 0 to 3 guarantees (every hunk attributed, every fork-owned file in exactly
  one add-on, an acyclic graph) were checked by a one-off script that was not kept, so they hold
  only as far as later changes kept the manifest up to date by hand.

## Hook modules for large fork blocks

A large fork feature inside an upstream adapter or component lives in a fork-only module beside
the file, and the upstream file keeps one marked hook per touch point: an import, an optional
interface field, a union member, a spread into an object, or one factory call. `ClaudeAdapterV2.ts`
and `CodexAdapterV2.ts` build session details through `claudeInsightsHooks.ts` and
`codexInsightsHooks.ts`; `ModelPickerContent.tsx` gets all its Hermes state from one
`useHermesModelPickerSections` call. Hook modules import adapter types with `import type` only and
take adapter-private values (the provider constant, query refs, error constructors) as arguments,
so there is no runtime import cycle. When a fork attribute would make the formatter rewrap an
upstream JSX element near the column limit, select the element from fork CSS by structure instead.

The Lineage panel's nesting follows the same shape: upstream's relationship shells stop at direct
children, so [`lineageTree.ts`](../../apps/web/src/subagents/lineageTree.ts) adds its own selector
for every live subagent below the thread and nests the rows into whole trees after upstream sorts
them into sections. Workflow members are skipped because their workflow row lists them.
The sidebar count can't come from the client's rows, since `omitIdleSubagents` shells leave idle
leaf subagents out. The subscriber snapshot names them in a fork `omittedSubagents` field
([`forkShellSubagents.ts`](../../packages/contracts/src/forkShellSubagents.ts)), grouped by a parent
it sends; removals drop ids client side, and expanding a row mounts its thread family for the rows.

Usage model rows are grouped the same way, after the merge:
[`usageModelGroups.ts`](../../packages/shared/src/usageModelGroups.ts) wraps `mergeUsage` in
the web's `mergeAnsweredUsage`, so the wire, the usage cache and mobile keep upstream's per-harness
rows; the table body is a fallback slot (below). The Grok reader tags `grok-N-build-fast` as Fast
speed without bumping upstream's scan-cache version, so Grok records cached before that change stay
Standard until their file is re-read.

## Fallback slots

Where an add-on replaces a block of upstream UI instead of adding beside it, the upstream file
keeps its block and renders it only while the add-on's slot in
[`forkSlots.ts`](../../apps/web/src/forkSlots.ts) is empty. The upstream file reads `forkSlots`
through `Fork add-on(core)` hooks, and each slot entry carries its add-on's id, so leaving the
add-on out brings back upstream's block unchanged.

- `usageModelRows`: the Usage → Breakdown → Model table body and the key a row opens the model
  dialog by, from usage-by-model's
  [`UsageModelBreakdown.tsx`](../../apps/web/src/components/usage/UsageModelBreakdown.tsx).
- `threadCardMeta`: the sidebar card's meta line, from compact-cards'
  [`ThreadCardMeta.tsx`](../../apps/web/src/fork-sidebar/ThreadCardMeta.tsx). The card always
  names its machine, so `metaLineEmpty` is false for cards while the slot is filled.

The kept block is upstream's code, so upstream changes to it merge without conflict. Port each one
into the add-on's component in the same sync, or the fork's version drifts from upstream's.

## Every upstream change is attributed

Each hunk of `git diff -w -U0 <merge base>` in an upstream code file is accounted for in one of
three ways:

- an added line in it carries a marker, which names the add-on that replaced the old lines;
- it only adds or removes closing brackets or tags;
- it only deletes upstream lines, and each one is listed in its add-on's `upstreamDeletions` in
  [`fork/addons.json`](../../fork/addons.json) with the reason.

Prefer a marked replacement to a listed deletion: put a fork import on the line of the upstream
import it replaces, and keep upstream blank lines. List a deletion only when nothing takes the
line's place, such as an import that a marked change left unused. A hunk that fits none of these
is not caught automatically (see [build-out status](#build-out-status)); the exporter assigns it to
the nearest marked hunk and warns.

## RPC scopes

Each fork RPC group declares the scope of every method in its own `*_RPC_SCOPES` map, which the
server spreads into `RPC_REQUIRED_SCOPES` through `apps/server/src/auth/forkRpcScopes.ts`; its
`satisfies Record<WsRpcMethod, …>` means a fork method cannot compile without one. Fork mutations
are also listed in
[`forkClientRpcScopes.ts`](../../packages/contracts/src/forkClientRpcScopes.ts), spread into
upstream's `CLIENT_GUARDED_RPC_SCOPES` by one marked line. That gives their
`createEnvironmentRpcCommand` a `permissionAtom`, so a restricted connection hides what the server
would refuse. Guarded methods can be called only through a command, never through raw `request`
or a query family. Reads stay unguarded, as upstream's do. A new fork mutation gets the same scope
in both maps. `hostBackups.list` is a read under `diagnostics:read`, because backup names and
versions describe the host the way process diagnostics do; it runs only while its dialog is open.

## MCP hub

[`forkMcp.ts`](../../apps/server/src/cli/forkMcp.ts) adds `t3 mcp token` and `t3 mcp stdio`,
registered by two marked lines in `binCli.ts`. Tokens go through the same `SessionStore.issue`
grant shape as `issueMcpClientSession` (subject, method, `mcpClientScopes`, runtime ceiling, bot
client), so MCP tool restrictions and Sharing & access revocation apply unchanged; only the TTL
is configurable, because OAuth's issuer fixes it at 30 days. Keep the two in step if upstream
changes the OAuth grant. `stdio` wraps `runAcpMcpStdioBridge` and takes the token only from
`T3_MCP_TOKEN`. User guide: [MCP hub](../user/mcp-hub.md).

## Marker exceptions

- JSON: `package.json`, `apps/server/package.json`, `packages/client-runtime/package.json`,
  `packages/provider-core/package.json`, `packages/shared/package.json`, and
  `apps/web/public/manifest.webmanifest`. `tsconfig.json` and `knip.jsonc` accept comments, so
  their fork lines carry markers.
- Generated output: `pnpm-lock.yaml`, `apps/web/src/routeTree.gen.ts`, and the web translation
  catalogs in `apps/web/src/i18n/translations/*.json`, which `gt generate` writes from source
  strings ([translations](./14_i18n.md)). Do not hand-mark package-manager, router or catalog
  output; regeneration would remove the markers. Never hand-edit the lockfile either: upstream
  sync rebuilds it from upstream's copy plus fork manifests
  ([conflicts](./local-source-updates.md#conflicts)), and a by-hand fix goes the same way:
  `git checkout upstream/main -- pnpm-lock.yaml && vp i --lockfile-only`.
- Binary icons: `apps/web/public/apple-touch-icon.png`, `apps/web/public/favicon-16x16.png`,
  `apps/web/public/favicon-32x32.png`, and `apps/web/public/favicon.ico`.
- `.gitignore` patterns cannot have trailing comments: the comment would become part of the
  pattern. Each fork pattern instead has an immediately preceding `# Fork add-on(<id>)` line.

`unmarkedUpstreamEdits` in `fork/addons.json` lists each of these files, except the translation
catalogs, under the add-on that makes the edit. The catalogs follow from source strings that carry
their own markers.

Blank separator lines need no marker. Except for the `.gitignore` rule above, never add
marker-only lines. Keep markers on real fork code in positions the formatter preserves, such as
list elements. An upstream line the formatter rewraps around a fork addition gets one marker only
when `git diff -w` still shows it changed, so its hunk stays attributed. Use comments
inside JSX expressions or tags and XML comments in SVG, never marker text in strings, template
payloads, JSX text, or JSON.

## Identity

The fork's identity is in two fork-owned files:
[`RemoteAppDistribution.ts`](../../apps/desktop/src/remote-apps/RemoteAppDistribution.ts) and
[`packages/shared/src/branding.ts`](../../packages/shared/src/branding.ts). They set the app id
`dev.neuman.t3code`, the `t3code-tjn` Electron profile directory and link scheme, and the Dock and
window name "ndev.t3code", so the app installs beside official T3 Code without sharing its profile
or links. Server state is not part of the identity: it stays in `~/.t3` like upstream, so threads
and settings carry over from the official app.

The fork's artwork is in [`assets/ndev/`](../../assets/ndev/README.md), which explains its source,
formats and `vp run icons:export:ndev`. Desktop builds, source launches and web icons read it
through [`fork-brand-assets.mjs`](../../scripts/lib/fork-brand-assets.mjs). The upstream
`assets/` artwork and its Icon Composer export stay as upstream ships them.

Upstream tests that assert upstream identity, such as the product name, app id, or protocol, are
expected to mismatch on the fork. Leave them as upstream wrote them; editing them only adds merge
surface.

## Marker check during upstream sync

Upstream sync ([local source updates](./local-source-updates.md)) requires no unexplained
marked-line loss. It counts lines containing `Fork add-on` per file before and after the merge.
Files with deficits get one repair pass with their original `HEAD:path:line:text` lines. Restore
fork behavior in upstream's current form, keep markers inline with their ids, and move them with
moved code; never recreate obsolete scaffolding or add markers to lines without fork behavior.
Unrestored lines need an explicit moved or obsolete disposition: a move consumes the named
destination's surplus over its HEAD file (following renames) once per marker, and an obsolete
line needs a reason. A file the merge deleted always needs dispositions for its markers, even when
other files gained some. Accepted dispositions are recorded in the merge commit. Unexplained
losses attempt `git merge --abort`; an abort failure or anything left in the checkout is reported
rather than cleaned up.

This catches the quiet failure of a clean merge: upstream rewrites the code around a hook, git
takes upstream's version, and the hook disappears without a conflict. It only works when every
fork code line in an upstream file carries its marker inline. It counts markers, not add-ons: a
marker whose id is wrong, or a fork file missing from the manifest, passes it.
