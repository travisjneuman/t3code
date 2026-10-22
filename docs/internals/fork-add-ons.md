# Fork add-ons

ndev.t3code is upstream T3 Code plus add-ons. Every upstream merge is cheaper the less the fork
touches upstream files, so the fork is shaped like a plug-in rather than a patch set.

## Fork-owned files and hooks

- Fork features live in fork-owned files: files that do not exist in `upstream/main`. They can
  change freely; upstream merges never conflict with them.
- An upstream file gets only one-line hooks at stable points that call into fork-owned code: an
  import, a spread into a list or layer, a mount. A hook is one line so a conflict on it is
  obvious and quick to re-apply.
- Every fork code line in an upstream file carries `Fork add-on` inline, usually as a trailing
  comment naming the feature. A multi-line fork comment is marked once on its first line.
  `git grep -n "Fork add-on"` lists the whole fork footprint in upstream files, and a fork change
  to an upstream file without the marker is a bug.
- JSON and binary assets cannot hold comments, and generated files cannot retain hand-added
  markers reliably. The exceptions below are not protected by the marker check; review their
  fork diff explicitly during upstream sync. Keep those edits to what a feature cannot do without.
- Upstream docs stay identical to `upstream/main`. Fork documentation is in fork-owned pages under
  `docs/`, and the repository landing page is `.github/README.md`. When the fork changes how an
  upstream feature behaves, say so in [`fork-behavior.md`](../user/fork-behavior.md), not in the
  upstream guide.

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

Usage model rows are grouped the same way, after the merge:
[`usageModelGroups.ts`](../../packages/shared/src/usageModelGroups.ts) wraps `mergeUsage` in
the web's `mergeAnsweredUsage`, so the wire, the usage cache and mobile keep upstream's per-harness
rows. The model `<tbody>` in `UsagePage.tsx` is replaced, not wrapped, by
[`UsageModelBreakdown.tsx`](../../apps/web/src/components/usage/UsageModelBreakdown.tsx). Its
deletion carries no marker, so an upstream sync that touches that table must port the change into
the fork component rather than restore the deleted block.

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
in both maps.

## Host release source and backups

The descriptor's `releaseSource` comes from the build's release repository plus the
`T3CODE_RELEASE_BASE_URL` override (`cliReleaseSourceOf`). It is display and gating data only; a
server always installs from its own base. Bulk update gating is in
`host-release/hostReleaseSource.ts`, and the single-update warning reads the live config at click
time (`hostReleaseGuard.ts`), so every `ServerUpdateAction` caller gets it without new props. The
HTTPS mirror check is the one function `cliReleaseBaseUrlProblem`, called by `t3 update`,
self-update, boot-service install and the SSH runner script; release downloads are capped at
768 MB, counted as they stream whenever the declared length can't bound the body.
`hostBackups.list` is a read under `diagnostics:read`, because backup names and versions describe
the host the way process diagnostics do; it runs only while its dialog is open.

## Marker exceptions

- JSON: `package.json`, `apps/server/package.json`, `apps/web/package.json`,
  `packages/provider-core/package.json`, `packages/shared/package.json`, and
  `apps/web/public/manifest.webmanifest`. `tsconfig.json` files accept comments, so their fork
  lines carry markers.
- Generated output: `pnpm-lock.yaml` and `apps/web/src/routeTree.gen.ts`. Do not hand-mark
  package-manager or router output; regeneration would remove the markers. Never hand-edit the
  lockfile either: upstream sync rebuilds it from upstream's copy plus fork manifests
  ([conflicts](./local-source-updates.md#conflicts)), and a by-hand fix goes the same way:
  `git checkout upstream/main -- pnpm-lock.yaml && vp i --lockfile-only`.
- Binary icons: `apps/web/public/apple-touch-icon.png`, `apps/web/public/favicon-16x16.png`,
  `apps/web/public/favicon-32x32.png`, and `apps/web/public/favicon.ico`.
- `.gitignore` patterns cannot have trailing comments: the comment would become part of the
  pattern. Each fork pattern instead has an immediately preceding `# Fork add-on` line.

Blank separator lines need no marker. Except for the `.gitignore` rule above, never add
marker-only lines. Keep markers on real fork code in positions the formatter preserves, such as
list elements; do not mark upstream lines merely rewrapped around a fork addition. Use comments
inside JSX expressions or tags and XML comments in SVG, never marker text in strings, template
payloads, JSX text, or JSON.

## Identity

The fork's identity is in two fork-owned files:
[`RemoteAppDistribution.ts`](../../apps/desktop/src/remote-apps/RemoteAppDistribution.ts) and
[`packages/shared/src/branding.ts`](../../packages/shared/src/branding.ts). They set the app id,
the Electron profile directory, the `t3code-tjn` link scheme, and the Dock and window name
"ndev.t3code", so the app installs beside official T3 Code without sharing its profile or links.
Server state is not part of the identity: it stays in `~/.t3` like upstream, so threads and
settings carry over from the official app.

The fork's artwork is in [`assets/ndev/`](../../assets/ndev/README.md), which explains its source,
formats and `vp run icons:export:ndev`. Desktop builds, source launches and web icons read it
through [`fork-brand-assets.mjs`](../../scripts/lib/fork-brand-assets.mjs). The upstream
`assets/` artwork and its Icon Composer export stay as upstream ships them.

Upstream tests that assert upstream identity, such as the product name, app id, or protocol, are
expected to mismatch on the fork. Leave them as upstream wrote them; editing them only adds merge
surface.

## Marker check during upstream sync

Upstream sync ([local source updates](./local-source-updates.md)) requires no unexplained
marked-line loss. Files with marker deficits get one repair pass with their original
`HEAD:path:line:text` lines. Restore fork behavior in upstream's current form, keep markers inline,
and move them with moved code; never recreate obsolete scaffolding or add markers to lines without
fork behavior. Unrestored lines need an explicit moved or obsolete disposition: a move consumes
the named destination's surplus over its HEAD file (following renames) once per marker, and an
obsolete line needs a reason. A file the merge deleted always needs dispositions for its markers,
even when other files gained some. Accepted dispositions are recorded in the merge commit.
Unexplained losses attempt `git merge --abort`; an abort failure or anything left in the checkout
is reported rather than cleaned up.

This catches the quiet failure of a clean merge: upstream rewrites the code around a hook, git
takes upstream's version, and the hook disappears without a conflict. It only works when every
fork code line in an upstream file carries its marker inline.
