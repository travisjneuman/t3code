# Fork host builds and updates

Fleet builds are optional and stay off when `~/.config/t3code-fork/hosts.json` is absent; desktop
source updates still work without a fleet. With that private inventory present and local source
updates enabled, **Update** starts the Mac app build and each configured Windows or Linux host's
server build in parallel for the same commit, before the new Mac app is installed. Ordinary repository
pushes, pulls, commits, startup and reconnects do not start a build. No hosted build, GitHub release,
tag, or archive transfer is part of this workflow.

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

Older inventories may still contain `buildHosts` or `stageFrom`. The local build flow ignores both:
every configured host builds its own native server in its own checkout. Remove those legacy fields
from the private inventory when convenient; the command does not require a config migration.

## User-triggered build

The desktop's **Update** pushes the fork commit, then starts the local Mac build and remote host
coordinator in parallel for the same full commit SHA:

```sh
node scripts/tjn-hosts.ts build-local --expect-sha <full-sha> --result-file "$HOME/Library/Application Support/t3code-fork/host-fleet-build-result.json"
node scripts/tjn-hosts.ts status
```

The old `release` command fails closed with instructions to update the desktop and retry the host
build. During the one-time bootstrap, an older desktop's explicit **Update** installs the new desktop,
while its legacy host-build fallback fails closed. After that update, use **Retry** on the failed host
build to build the same already-pushed commit. The old startup fallback must never build the fleet.
`stage` and `--build-host` are retired. Do not run `build-local` as a response to an ordinary
repository sync or push.

Before a remote build, the coordinator checks that the expected SHA is the current pushed
`origin/main`, the Mac checkout is on `main`, and the source files sent to hosts match that commit.
Each host checks its canonical checkout, fetches the fork, fast-forwards to the exact SHA, and builds
its own server at lower priority. A host stages the result in its local
`runtime/versions/<nightly>+<sha-prefix>` directory. The full SHA is written as installed provenance.
The archive and per-run build cache are removed after each attempt. Compiler caches inside the checkout
may remain ignored so a later build can reuse them.

The coordinator attempts every configured host even if another host is unavailable. It names hosts
that are offline or fail to build or stage. Any such failure exits unsuccessfully and leaves no success
result file, even if other hosts completed. **Retry** repeats the host build for the same expected
SHA; it does not choose a newer commit. On success, `host-fleet-build-result.json` contains both the
full `commit` SHA and `targetVersion`. The desktop accepts it only when the commit matches the saved
build request, the target version has that commit's SHA prefix, and every configured host reports that
same target. It then queues the existing host update flow. That flow waits for the host's sessions to
stay idle before it restarts the server. A failed or cancelled host activation does not trigger another
build; retry that host's activation through **Settings → Connections**. Press the desktop's overall
**Update** again only when you want a new source commit built.

The Mac app's own source build remains in `LocalSourceUpdates`; the host coordinator never builds the
Mac app. The app and every configured remote host use the same SHA-based runtime identity so an app
update always targets the exact source commit that was pushed.

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

## Status, cleanup, and rollback

`status` reports host runtimes and service state, active host-run journals, and any legacy fork release
metadata. Hosts activate staged builds through the existing idle-aware update queue. After a successful
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
