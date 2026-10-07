# Fork add-ons

ndev.t3code is upstream T3 Code plus add-ons. Every upstream merge is cheaper the less the fork
touches upstream files, so the fork is shaped like a plug-in rather than a patch set.

## Fork-owned files and hooks

- Fork features live in fork-owned files: files that do not exist in `upstream/main`. They can
  change freely; upstream merges never conflict with them.
- An upstream file gets only one-line hooks at stable points that call into fork-owned code: an
  import, a spread into a list or layer, a mount. A hook is one line so a conflict on it is
  obvious and quick to re-apply.
- Every fork line in an upstream file carries the text `Fork add-on`, usually as a trailing
  comment naming the feature. `git grep -n "Fork add-on"` lists the whole fork footprint in
  upstream files, and a fork change to an upstream file without the marker is a bug.
- Upstream docs stay identical to `upstream/main`. Fork documentation is in fork-owned pages under
  `docs/`, and the repository landing page is `.github/README.md`.

## Identity

The fork's identity is in two fork-owned files:
[`RemoteAppDistribution.ts`](../../apps/desktop/src/remote-apps/RemoteAppDistribution.ts) and
[`packages/shared/src/branding.ts`](../../packages/shared/src/branding.ts). They set the app id,
the Electron profile directory, the `t3code-tjn` link scheme, and the Dock and window name
"ndev.t3code", so the app installs beside official T3 Code without sharing its profile or links.
Server state is not part of the identity: it stays in `~/.t3` like upstream, so threads and
settings carry over from the official app.

Upstream tests that assert upstream identity, such as the product name, app id, or protocol, are
expected to mismatch on the fork. Leave them as upstream wrote them; editing them only adds merge
surface.

## Marker check during upstream sync

Before each upstream merge, the sync ([local source updates](./local-source-updates.md)) counts
the `Fork add-on` lines in each file. After the merge it counts again. Files that lost marker lines
are handed once to the merge agent to re-apply them. If any are still missing, the merge is
aborted and the checkout is left as it was.

This catches the quiet failure of a clean merge: upstream rewrites the code around a hook, git
takes upstream's version, and the hook disappears without a conflict. It only works when every
fork line in an upstream file carries the marker.
