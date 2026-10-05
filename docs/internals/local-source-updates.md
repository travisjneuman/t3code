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
- The build stamps the tag's version into the release package manifests, as
  upstream's release workflow does, and restores them afterwards. The server
  reports its own package version, so an unstamped build shows a client/server
  mismatch and offers a server update that does not exist.
- "Behind" is counted against the tag's commit. A fork that already contains it is
  up to date even if `upstream/main` has moved on.

## Merge, build, then commit

The merge runs with `--no-ff --no-commit`. Nothing is committed until the build
succeeds, so every failure before that point (unresolvable conflicts, build failure,
interruption) ends in `git merge --abort` and leaves the checkout as it was. Only
after the commit is the build remembered and `origin HEAD:main` pushed; a failed push
is retried by the next update, which finds the fork current and a build pending.

## Sync without building

`syncSource` (the sidebar merge button) merges `upstream/main` itself, commits,
and pushes, with the same conflict handling but no build gate. Update then has two
triggers: the fork is behind the newest nightly, or the fork already contains it
(merged by a sync) while the running app's version is older. The second case
builds without merging and commits only what the build changed (lockfile, agent
fixes); on failure those edits are stashed so the checkout stays clean. Sync and
update share one lock because both rewrite the checkout, and the exported `inspect`
takes it too, so an update check never reads the checkout mid-merge.

`DesktopUpdates` also runs `autoSyncSource` a minute after startup and every 30
minutes, then rechecks for updates; it never builds. It merges only the newest
nightly (the same target update uses), not `upstream/main`, because update builds
are keyed to nightly versions: commits past the nightly would sit unbuilt until
the next one anyway. It has no agent: conflicts the rename pass leaves abort the
merge, and that nightly is remembered (in memory) and skipped until a newer one
lands or the button, which has the agent, merges it. A dirty checkout fails
`inspect`, so a round during local edits is a logged skip. Every round that
merges pushes the fork; GitHub
Actions are disabled on the fork, so a push costs no CI.

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

`pnpm-lock.yaml` conflicts always take upstream's file; `vp i` runs before every
build and regenerates it from the merged manifests.

## Agent fallback

Conflicts the rename pass leaves, and a merge that no longer builds (upstream
reshaped something the fork imports), go to a headless `claude -p` run in the
checkout. It is limited to file tools (no Bash, git, or network), told to keep
both upstream changes and fork additions, and capped at 20 minutes. A path that
still has conflict markers afterwards aborts the update; a build fix gets one agent
pass and one rebuild. The build stays the gate: nothing is committed or pushed
unless it passes, and the merge commit skips hooks so the formatter cannot rewrite
upstream files. It needs the Claude CLI installed and signed in where the desktop
app can find it on `PATH`.

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
replacement move fails. On success it deletes that backup and the build output, so
an update leaves exactly one installed app. At most one build is kept on disk: each
new build and each failed build clears the `source-updates` directory.
