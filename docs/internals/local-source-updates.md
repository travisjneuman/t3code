# Local source updates

A packaged macOS build of the fork whose source checkout is still available updates
from that checkout instead of a release feed. `LocalSourceUpdates`
(`apps/desktop/src/updates/LocalSourceUpdates.ts`) turns the desktop update button
into "merge the newest upstream nightly into the fork, build it here, push it, swap
the bundle". `ForkDesktopUpdates` (`updates/ForkDesktopUpdates.ts`), which `main.ts`
provides in place of upstream's `DesktopUpdates.layer`, routes check, download, and
install to it whenever it reports `enabled`; otherwise the release feed is the repository named at build
time (`T3CODE_DESKTOP_UPDATE_REPOSITORY` or `GITHUB_REPOSITORY`), and a build without
one has no feed.

## Target: the nightly tag, not upstream/main

The merge target is the newest `v*-nightly.*` tag contained in `upstream/main`, not
the branch tip. A nightly tag is a commit upstream already built and released, so
the fork never lands on an arbitrary in-between commit, and the tag doubles as the
version label and `--build-version` (tag without the leading `v`).

- Fetch takes only `main` and `refs/tags/v*`, with `--no-tags`. Upstream force-moves
  rolling tags (`android-nightly`, `desktop-preview`), and `--tags` fails the whole
  fetch on them. Version tags never move, so one that did is still refused rather
  than clobbered. There is no `--prune`: with a tag refspec it would delete
  fork-local `v*` tags.
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
succeeds. Failures before that point (unresolvable conflicts, build failure,
interruption) attempt `git merge --abort` without staging edits during cleanup:
that could discard unrelated work created while the agent ran. Cleanup checks Git's
exit status; failure reports manual recovery with Git's output. After a successful
abort, any remaining modified or untracked paths are reported as "left in the checkout"
rather than removed or claimed clean. Only after the commit is the build remembered
and the fork pushed.

Post-repair and build-finalization staging uses `git add -u`, never blanket staging
of untracked files. Conflict resolutions still stage only their explicit paths, and
files added by Git's merge are already in the index. The only additional new files
allowed are exact destinations of accepted `moved` dispositions: repair accounting
reads their working-tree markers before explicitly staging those literal paths.
Any other non-ignored untracked files at these staging points fail the operation
with a bounded path list and are left untouched. This also refuses genuinely new
build-repair files that were not already accepted and staged during marker repair.
Both repair and finalization failures use the same abort-and-report cleanup above;
finalization happens after the temporary release version has been restored. If abort
fails, the merge is left for manual recovery, not claimed clean. The initial clean-tree
check and in-process lock do not detect concurrent edits to tracked files; those edits
can still be staged, committed, or affected by cleanup. Avoid other writers during a run.

The push is best-effort and goes only to `origin`, which must not be upstream. Whoever
builds the fork may have no write access to it, so a failed push never fails the
update: the merge and build stand, and the result says the push was skipped. Nothing
ever pushes to `upstream`.

When `TJN_REPO_SYNC_RUNNER` names an existing repository sync script, the push runs
`python3 <runner> push-safe` in the checkout instead of `git push origin HEAD:main`, so
the owner's other checkouts are pulled to the same commit. A Finder launch has no shell
environment, so the variable is read from the login shell with `PATH`. The runner
exits 0 when it refuses, so only a last output line starting with `pushed` counts as
pushed; a push whose fan-out was blocked is logged as a warning.

## Sync without building

`syncSource` (the sidebar merge button) merges `upstream/main` itself, commits,
and pushes, with the same conflict handling but no build gate. Update then has two
triggers: the fork is behind the newest nightly, or the fork already contains it
(merged by a sync) while the running app's version is older. The second case
builds without merging and commits only what the build changed (lockfile, agent
fixes); on failure tracked edits are stashed, while untracked files remain untouched
and are reported as checkout leftovers. A failed stash is surfaced as a checkout
that may still be dirty and needs manual recovery. Sync and update share one lock
because both rewrite the checkout, and the exported `inspect` takes it too, so an
update check never reads the checkout mid-merge.

The sidebar button's tooltip and accessible label show the current phase: fetching,
merging, resolving conflicts with Claude (including the conflict count), checking
fork add-ons, repairing, committing, and pushing. The main process owns progress;
a fork IPC snapshot plus events keep reloaded and additional windows in sync.
Concurrent interactive requests join one in-flight result, with one completion
clear per operation. Older desktop shells retain the generic syncing label.

`ForkDesktopUpdates` also runs `autoSyncSource` a minute after startup and every 30
minutes, then rechecks for updates; it never builds. It merges only the newest
nightly (the same target update uses), not `upstream/main`, because update builds
are keyed to nightly versions: commits past the nightly would sit unbuilt until
the next one anyway. It has no agent: any conflict outside `pnpm-lock.yaml`, or a
lost `Fork add-on` line, aborts the merge, and that nightly is remembered (in memory)
and skipped until a newer one lands or the button, which has the agent, merges it. A dirty checkout fails
`inspect`, so a round during local edits is a logged skip. Every round that
merges tries the same push.

## One build per checkout

Two desktop builds in one checkout overwrite each other's `dist` output, and a merge
during a build changes the code being built. `scripts/build-desktop-artifact.ts` holds
`release/.desktop-build.lock` (gitignored, holding its pid) for the whole build, and a
second build refuses to start. Sync, auto-sync and update check the lock before they
touch the checkout: auto-sync skips that round and tries again 30 minutes later, and
the button or update reports the running build. `inspect` leaves the version stamp in
place while a build holds the lock, since that build owns it. A lock whose process is
gone, or older than six hours, is stale and replaced. The app's own `vp i` runs before
its build takes the lock, so a terminal build started during that install is not
caught.

## Conflicts

`pnpm-lock.yaml` conflicts always take upstream's file; `vp i` runs before every
build and regenerates it from the merged manifests.

## Agent fallback

Conflicts outside the lockfile, and a merge that no longer builds (upstream
reshaped something the fork imports), go to a headless `claude -p` run in the
checkout. It is limited to file tools (no Bash, git, or network), told to keep
both upstream changes and fork additions, and capped at 20 minutes. A path that
still has conflict markers afterwards aborts the update; a build fix gets one agent
pass and one rebuild. A non-zero agent exit or timeout stops the operation immediately,
without another repair pass. Agent spans record the phase, elapsed milliseconds,
and exit code (null when no exit code was obtained), not prompts or subprocess output.

Files that lost `Fork add-on` lines in the merge also get one agent pass
([fork add-ons](./fork-add-ons.md#marker-check-during-upstream-sync)). Preserve fork
behavior, not obsolete upstream scaffolding: every fork line keeps its marker inline,
and markers move with moved code. Never add markers to lines without fork behavior.
The rule is **no unexplained marked-line loss**. The repair agent receives the
original `HEAD:path:line:text` lines for files with deficits and ends
with a fenced JSON `dispositions` list for lines not restored in place. Each entry
names an original path and line, `moved` or `obsolete`, and a reason; moves also name
the current destination. Only the last JSON fence is parsed; missing or malformed
output gives no credit. Repair stdout is bounded to 1,048,576 characters; truncation
fails explicitly rather than silently losing the report. Duplicate or unlisted
originals are rejected. Moves must spend a real destination's surplus over HEAD once
per marker, resolving renamed destinations to their original HEAD paths; a destination
with its own deficit has no surplus. Obsolete lines need a non-empty reason.
Valid dispositions cover only their source file's remaining
deficit and are recorded in both sync and build-gated merge commit bodies. The build
path rechecks the accepted explanations after build repairs, without another marker
agent pass. Renames are followed; every marked line in a deleted file needs a validated
move or obsolescence explanation, even when unrelated files gained markers. Unexplained
losses still abort. Counts and agent explanations detect possible loss; they do not
prove behavior is preserved.

For a source update with a build, nothing is committed or pushed unless the build
passes; sidebar sync has no build gate. The merge commit skips hooks so the formatter
cannot rewrite upstream files. The Claude CLI must be installed and signed in where
the desktop app can find it on `PATH`. Optional environment overrides in that app's
environment apply to each conflict, marker-repair, and build-repair agent run:

- `T3CODE_MERGE_AGENT_MODEL` passes `--model <model>`.
- `T3CODE_MERGE_AGENT_EFFORT` passes `--effort <level>`; the CLI help lists `low`,
  `medium`, `high`, `xhigh`, and `max` (support depends on the installed CLI/model).

Unset or blank values add no flag, preserving the CLI's existing defaults.

## Guards and installation

The build records the absolute path of the checkout it was built from, and the
updater is enabled only for a packaged macOS build whose recorded checkout still
exists and is a git work tree. `T3CODE_SOURCE_REPOSITORY_PATH` overrides the recorded
path. Nothing names a particular fork: the checkout needs an `upstream` remote at
`pingdotgg/t3code` and an `origin` that is not upstream. It refuses dirty checkouts,
in-progress merges, and branches other than `main`. Builds use a directory target with
`--publish never` and are stored outside the checkout until installation. Unsigned
packages are ad-hoc sealed so local bundle validation can run, but stay unnotarized.
The installed bundle is replaced only by a detached helper after the parent process
exits; it keeps the prior app at a `.previous-<pid>` path and restores it if the
replacement move fails. On success it deletes that backup and the build output, so
an update leaves exactly one installed app. At most one build is kept on disk: each
new build and each failed build clears the `source-updates` directory.
