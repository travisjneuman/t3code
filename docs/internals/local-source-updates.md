# Local source updates

Packaged macOS builds of the fork do not read a release feed. `LocalSourceUpdates`
(`apps/desktop/src/updates/LocalSourceUpdates.ts`) turns the desktop update button
into "merge the newest upstream nightly into the fork, build it here, push it, swap
the bundle". `DesktopUpdates` routes check, download, and install to it whenever
it reports `enabled`.

## Target: the nightly tag, not upstream/main

The merge target is the newest `v*-nightly.*` tag contained in `upstream/main`, not
the branch tip. A nightly tag is a commit upstream already built and released, so
the fork never lands on an arbitrary in-between commit, and the tag doubles as the
version label and `--build-version` (tag without the leading `v`).

- Fetch is `git fetch --prune --tags upstream main`. Tags fetched through `--tags`
  are exempt from `--prune`, so fork-local tags survive; a tag that moved upstream is
  refused rather than clobbered.
- Selection sorts by `v:refname`, not `creatordate`. The tag name encodes version,
  date, and run number, while a lightweight tag's creator date is its commit date.
  The list is ascending and the last line wins, so tail-truncated command output
  still contains the newest tag.
- "Behind" is counted against the tag's commit. A fork that already contains it is
  up to date even if `upstream/main` has moved on.

## Merge, build, then commit

The merge runs with `--no-ff --no-commit`. Nothing is committed until the build
succeeds, so every failure before that point (unresolvable conflicts, build failure,
interruption) ends in `git merge --abort` and leaves the checkout as it was. Only
after the commit is the build remembered and `origin HEAD:main` pushed; a failed push
is retried by the next update, which finds the fork current and a build pending.

## Rename-only conflict resolution

The fork renames the product text, which collides with most upstream edits to the
same lines. `forkMergeResolution.ts` resolves a conflict only when the fork's entire
change is that rename (base plus rename equals ours, ignoring whitespace); it then
takes upstream and reapplies the rename. Two passes run over `git ls-files -u`:
whole-file from the index stages, then per hunk after
`git checkout --conflict=diff3`. Binary content, symlinks, submodules, and mode
changes are never rewritten. Any path still unmerged aborts the whole update with
the list, because a partially auto-merged fork is worse than a clean manual merge.
Extending `FORK_RENAMES` widens what counts as rename-only.

## Guards and installation

The updater is guarded by the custom packaged macOS distribution and defaults to the
canonical maintainer checkout under `~/web-dev/t3code`; `T3CODE_SOURCE_REPOSITORY_PATH`
overrides that location for an intentional local installation. It refuses non-macOS
or unpackaged builds, missing checkouts, wrong repository roots, dirty or in-progress
merges, branch mismatches, and remote mismatches. Builds use a directory target with
`--publish never` and are stored outside the checkout until installation. Unsigned
packages are ad-hoc sealed so local bundle validation can run, but stay unnotarized.
The installed bundle is replaced only by a detached helper after the parent process
exits; it keeps the prior app at a `.previous-<pid>` path and restores it if the
replacement move fails.
