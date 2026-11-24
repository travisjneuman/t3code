# Fork host builds and updates

Fleet builds are optional and stay off when `~/.config/t3code-fork/hosts.json` is absent; desktop
source updates still work without a fleet. With that private inventory present and local source
updates enabled, **Sync & Build** starts the Mac app build and each configured Windows or Linux host's
server build in parallel for the same commit, before the new Mac app is installed. Ordinary repository
pushes, pulls, commits, startup and reconnects do not start a build. No hosted build, GitHub release,
tag, or archive transfer is part of this workflow. Every push goes to the fork's `origin`; nothing
here pushes to or opens pull requests against upstream `pingdotgg/t3code`.

Two add-ons share this flow. `host-releases` (distribution) is the part in the app: the desktop
publisher that starts and watches host builds, the web auto-update that activates them, the fork's
release source and HTTPS mirror checks, server release facts and runtime retention. `tjn-fleet`
(personal) is the owner's scripts it runs: `scripts/tjn-hosts.ts`, `scripts/lib/tjn-hosts/` and
`scripts/tjn-build-host-archive.ts`. Without a host inventory the publisher stays off, and the
scripts are of no use to anyone else.

## Private host configuration

Keep the inventory outside the repository at `~/.config/t3code-fork/hosts.json`. Never commit host
identities, connection details, credentials, or local paths. Each entry under `hosts` needs its SSH
alias, operating system, canonical checkout, T3 home, separate build cache, Node argv prefix,
environment, login-shell setting, and service definition. Use absolute paths and keep each host cache
separate from its checkout and T3 home.

The version 1 inventory accepts an optional top-level `repository` string in GitHub `owner/name`
form. If omitted, the coordinator resolves it once from the Mac checkout's `origin` fetch URL.
HTTPS, `git@github.com:owner/name.git`, and `ssh://git@github.com/owner/name.git` origins are supported.
The Mac checkout's origin fetch and push URLs must both identify that repository; each host's origin
must identify it too. Legacy release downloads and service release-base matching use the same
resolved repository. The expected upstream remains `pingdotgg/t3code`.

The desktop app checks for the inventory once at startup; restart it after creating or removing
the file.

Older inventories may still contain `buildHosts` or `stageFrom`. The local build flow ignores both:
every configured host builds its own native server in its own checkout. Remove those legacy fields
from the private inventory when convenient; the command does not require a config migration.

## User-triggered build

The desktop's **Sync & Build** commits and pushes the upstream merge, then starts the local Mac build and
remote host coordinator in parallel for the same full commit SHA
([local source updates](../internals/local-source-updates.md#merge-push-then-build)). Only a push
that succeeded starts host builds. If the Mac build needs a fix commit, its push queues one more host
run for that commit, started when the current run ends. Starting the app only observes a run that an
earlier **Sync & Build** left; it never starts one. The coordinator runs detached from the app, so quitting
the app does not stop it; its log and exit code are kept in the app's state directory, and a run
with no exit code after six hours is no longer counted as running:

```sh
node scripts/tjn-hosts.ts build-local --expect-sha <full-sha> --result-file "$HOME/Library/Application Support/t3code-fork/host-fleet-build-result.json"
node scripts/tjn-hosts.ts status
```

`node scripts/tjn-hosts.ts` with no arguments prints the full usage. Exit codes: 0 success, 1
command or I/O failure, 2 usage, 3 preflight refusal or a locked host, 4 the fleet build may be
partial (read each host's output before continuing).

The old `release` command fails closed with instructions to update the desktop and retry the host
build. During the one-time bootstrap, an older desktop's explicit **Update** installs the new desktop,
while its legacy host-build fallback fails closed. After that update, use **Retry** on the failed host
build to build the same already-pushed commit. The old startup fallback must never build the fleet.
`stage` and `--build-host` are retired. Do not run `build-local` as a response to an ordinary
repository sync or push.

Before a remote build, the coordinator checks that the expected SHA is the current pushed
`origin/main`, the Mac checkout is on `main`, and the host build tools it sends match that commit.
Each host checks its canonical checkout, fetches the fork, fast-forwards to the exact SHA, and builds
its own server at lower priority. A host stages the result in its local
`runtime/versions/<nightly>+<sha-prefix>` directory. The full SHA is written as installed provenance.
The archive and per-run build cache are removed after each attempt. Compiler caches inside the checkout
may remain ignored so a later build can reuse them.

The coordinator attempts every configured host even if another host is unavailable. It names hosts
that are offline or fail to build or stage. Any such failure exits unsuccessfully and leaves no success
result file, even if other hosts completed. **Retry** repeats the host build for the same expected
SHA; it does not choose a newer commit. Only once every configured host has staged the target does
the coordinator write `host-fleet-build-result.json`, with the full `commit` SHA and
`targetVersion`. The desktop accepts it only when the commit matches the saved build request and
the target version ends with `+` and that commit's 12-character prefix.

Staged is not active. The hosts switch only once this Mac app itself runs that target, after
**Restart & Install** on the Mac, so a build that breaks the Mac never reaches the hosts. "Runs the
target" means this app's own connected server reports the target's nightly version and either the
same fork build or, for a build **Sync & Build** repaired with a fix commit, the desktop updater reports it is
up to date. The app then queues each connected host whose server updates itself as a boot service
in the existing update queue, which restarts its server at once. Hosts whose server belongs to a
desktop app or is respawned from npm are never queued, since that would relaunch someone's app or
install from npm. Each host is queued once per target, remembered across relaunches, so a failed or
cancelled activation is not queued again. Until then the hosts keep their current build; **Update
everything** still updates them by hand. A failed host build shows one error toast with the log
path and **Retry**. A failed or cancelled host activation does not trigger another
build; retry that host's activation through **Settings → Environments**. Press the desktop's overall
**Sync & Build** again only when you want a new source commit built.

The Mac app's own source build remains in `LocalSourceUpdates`; the host coordinator never builds the
Mac app. Each host's server is built with `T3CODE_FORK_BUILD` set to the commit's 12-character prefix,
as the Mac's is, so every machine reports which commit it runs. The app and every configured
remote host use the same SHA-based runtime identity, so an app update always targets the exact
source commit that was pushed.

## Builder details

The remote builder is invoked by the coordinator, not as a separate release process:

```sh
node scripts/tjn-build-host-archive.ts --version <nightly> --expect-sha <full-sha> --out <host-cache>
```

It requires a clean checkout at the requested SHA, installs dependencies, stamps package versions,
builds the server, client and native resource monitor, and packages a temporary local archive. It does
not run the archive smoke script. Output must stay outside the checkout; temporary builder scratch is
kept under the supplied output directory rather than the system temp directory. The archive exists
only long enough for the same host to install it into its local runtime directory.

## Release source and mirrors

Hosts that update from a published release rather than a local build resolve the release
repository from the validated `T3CODE_RELEASE_REPOSITORY=owner/name` first; otherwise they derive it
from `T3CODE_RELEASE_BASE_URL` only when that is `https://github.com/<owner>/<name>/releases/download`,
falling back to the fork's own repository. Downloads default to
`https://github.com/<resolved>/releases/download`; `T3CODE_RELEASE_BASE_URL` remains the download
override, including custom HTTPS mirrors, and the two variables must not name different
repositories. `cliReleaseSourceOf` reflects the resolved repository and download base in the
descriptor's `releaseSource`, used only for display and gating; a server installs from its own base.
A mobile app built from this repository still defaults to the fork's repository even when the
host uses another source; the published mobile app is upstream's. Bulk update
gating is in `apps/web/src/host-release/hostReleaseSource.ts`, and the single-update warning reads
the live config at click time (`hostReleaseGuard.ts`), so every `ServerUpdateAction` caller gets it
without new props. The HTTPS mirror check is the one function `cliReleaseBaseUrlProblem` in
`packages/shared/src/cliReleaseGuards.ts`, called by `t3 update`, self-update, boot-service install
and the SSH runner's release mirror; release downloads are capped at 768 MB, counted as they stream
whenever the declared length can't bound the body.

The repository still carries two GitHub workflows from before local builds,
`.github/workflows/tjn-upstream-sync.yml` (a scheduled text merge of `upstream/main`) and
`tjn-macos-nightly-release.yml` (a scheduled hosted Mac release). Neither is part of this flow: the
desktop app does every upstream merge and every build. Their conditions allow this repository, or
another fork that sets `T3CODE_FORK_UPSTREAM_SYNC` or `T3CODE_FORK_NIGHTLY_RELEASE` to `true`, so
both stay disabled in this repository's Actions settings. The sync workflow pushes only to the
fork, but has no lockfile rebuild and no marker check, so it is not a substitute for the desktop's
merge.

## Status, cleanup, and rollback

`status` reports host runtimes and service state, host-run locks and journals, and any legacy fork
release metadata. Each run holds a per-host lock and a phase journal under
`~/Library/Application Support/t3code-fork/host-runs`. A run stopped by a shutdown, logout or kill
keeps its locks and records the signal. The next `build-local` (or **Retry**) reclaims them by
itself: each host re-checks its own state, and a host-side lock keeps a rerun from deleting the cache
of a build that an orphaned run left going. A lock counts as live only while its PID still runs
since the current boot, so a restart never leaves a reused PID holding it. An interrupted `prune` or
`rollback` still refuses until its journal has been read, because a service may be stopped.

Hosts activate staged builds through the existing update queue. After a successful
commit, the runtime manager removes older runtime versions according to its commit/retention rules.
After rollback, the failed candidate runtime is removed separately from successful-commit pruning.
During a pending update, the active runtime and the temporary T3 database recovery copy remain
available until the update reaches a terminal result; the recovery copy is removed after commit or
rollback, and cleanup failures are logged. This temporary T3 update-specific allowance is not a
general backup rule. The build command itself creates no previous-release backup or archive. Since an
older runtime may not remain after a successful commit, manual rollback is not guaranteed; fix forward
when no compatible installed runtime is available.

The existing `prune` and `rollback` maintenance commands still require an idle confirmation and use
conservative database-migration checks. Rollback may be refused when there is no verified migration
receipt, compatible recovery point, or older installed runtime; fix forward rather than guessing.
Normal builds do not fetch old releases. A local host build creates no GitHub release receipt, so
release-based rollback metadata is not generated by this workflow.

## Launcher protocol changes

A remote update replaces only the server that the service launcher runs, not the launcher itself.
When upstream raises `SERVICE_LAUNCHER_PROTOCOL` (`apps/server/src/cloud/serviceProtocol.ts`), the
staged build's preflight refuses that update on every host: the new server cannot run under the old
launcher. The fleet build still stages normally; only activation is blocked. Upstream's fix is a
local `t3 service install`, which refuses Windows and, for fork builds, would point at a release
upstream never published.

After `build-local` has staged the pushed `origin/main` everywhere, move the services onto the new
launcher with:

```sh
node scripts/tjn-hosts.ts service-install --all --dry-run
node scripts/tjn-hosts.ts service-install --all --confirm-idle
```

The target is the build staged for the pushed `origin/main`, and its protocol is read from that
commit. Before stopping anything, each host runs the staged build's own read-only preflight against
its database with that protocol, so a migration problem refuses while the service still runs. The
host then stops the service, fills `runtime/current` with the staged build, writes
`service-state.json` with the new protocol and active version, starts the service, and confirms the
new version within 60 seconds. The service file is unchanged and must already run
`runtime/current`. A host already on that build and protocol is skipped. The run stops at the first
failing host and leaves later hosts untouched. No backup is taken; the old runtime is pruned by the
new launcher as usual, so fix forward.
