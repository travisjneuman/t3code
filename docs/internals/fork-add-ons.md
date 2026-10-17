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

## Marker exceptions

- JSON: `package.json`, `apps/server/package.json`, `apps/web/package.json`,
  `packages/provider-core/package.json`, `packages/shared/package.json`, and
  `apps/web/public/manifest.webmanifest`. `tsconfig.json` files accept comments, so their fork
  lines carry markers.
- Generated output: `pnpm-lock.yaml` and `apps/web/src/routeTree.gen.ts`. Do not hand-mark
  package-manager or router output; regeneration would remove the markers.
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
