# Fork host releases

Publish headless fork servers for Windows and Linux independently of the Mac app's source updates.
The Mac coordinates the release and uploads with `gh`; a Windows build host and a Linux build host
build their own archives from the same fork commit. No CI, Actions or scheduled release jobs are
needed. Publishing does not update running hosts.

## Private host configuration

Keep the host inventory outside the repository at `~/.config/t3code-fork/hosts.json`. Never commit
host identities, connection details or local paths. This placeholder example shows a Windows build
host and a Linux build host; replace its aliases and paths with your private values:

```json
{
  "version": 1,
  "hosts": {
    "windows-build": {
      "ssh": "windows-build-alias",
      "os": "win32",
      "checkout": "C:\\path\\to\\checkout",
      "t3Home": "C:\\path\\to\\t3-home",
      "cacheDir": "C:\\path\\to\\release-cache",
      "node": ["node"],
      "env": {},
      "loginShell": false,
      "service": {
        "kind": "task",
        "name": "Example server task",
        "file": "C:\\path\\to\\t3-service.cmd"
      }
    },
    "linux-build": {
      "ssh": "linux-build-alias",
      "os": "linux",
      "checkout": "/path/to/checkout",
      "t3Home": "/path/to/t3-home",
      "cacheDir": "/path/to/release-cache",
      "node": ["node"],
      "env": {},
      "loginShell": true,
      "service": {
        "kind": "systemd",
        "unit": "example-server.service",
        "file": "/path/to/user-units/example-server.service"
      }
    }
  },
  "buildHosts": {
    "win32-x64": ["windows-build"],
    "linux-x64": ["linux-build"]
  }
}
```

`hosts` maps inventory names to SSH aliases, OS, canonical checkout, T3 home, external release cache,
Node invocation and service definition. `node` is an argv prefix array, not a shell command;
`env` supplies environment overrides and `loginShell` selects a login shell where needed
for the host's toolchain. A Windows service names its scheduled task and launcher file; a Linux
service names its user systemd unit and unit file.

Each `buildHosts` list is ordered: the first reachable host builds that platform. Add a configured
fallback host's inventory name after the preferred builder. Keep caches disjoint from both the
checkout and T3 home.

## Release and update

Run the coordinator from the fork checkout on the Mac:

```sh
node scripts/tjn-hosts.ts release
node scripts/tjn-hosts.ts release --build-host <name>
node scripts/tjn-hosts.ts status
node scripts/tjn-hosts.ts prune <host> --confirm-idle
node scripts/tjn-hosts.ts prune --all --confirm-idle
node scripts/tjn-hosts.ts rollback <host> --confirm-idle
node scripts/tjn-hosts.ts rollback <host> --to <version> --confirm-idle
```

Use `--build-host` to select a configured builder explicitly for its platform; the other platform
still uses its ordered list. An unreachable explicit selection refuses the release rather than
falling back. The host-side builder can also be invoked on the Windows build host or Linux build
host:

```sh
node scripts/tjn-build-host-archive.ts --version V --expect-sha SHA --out <dir>
```

The builder requires a clean checkout at the expected commit. It installs dependencies, stamps the
release version, builds the server, client and native resource monitor, packages and smoke-tests the
archive, then restores stamped files even on failure. Its archive output directory must be outside
the checkout. The version cache also holds build logs and packaging/smoke scratch; intermediate
build output stays in gitignored checkout directories, including `apps/*/dist`, `apps/*/dist-exe`
and `native/resource-monitor/target`. It reports the archive path and SHA-256 for publication.

Release builds and rollback downloads refuse to reuse or overwrite an existing version cache;
the standalone builder also refuses to overwrite an archive. Failed builds retain their named
caches for inspection. Resolve those leftovers deliberately before rerunning; there is no
reuse-built option.

Routine Mac source updates and builds do not require host releases or host updates. Hosts move only
when a newer fork release is published and applied.

The steady-state workflow is:

1. Update the Mac app through its normal fork source update. Wait if there is no upstream nightly
   newer than the hosts' active versions; ordinary updates do not reinstall the same version.
2. Run `release` on the Mac. Preflight requires a clean checkout at `origin/main`, the merged nightly
   version to match the installed Mac app, and no existing fork release for that version. Unreachable
   hosts are reported and skipped, not validated or changed. Every reachable host must run an older
   version, and each platform needs a reachable configured builder.
   Other inspection failures refuse the release rather than counting as unreachable. Both platforms
   build from the same commit. The Mac collects the archives and `SHA256SUMS`, compares the builders'
   hashes, and uploads them together using `gh`.
3. In the Mac app, use each host's **Update** in **Settings → Connections**. Before a host's first
   fork update, set `T3CODE_RELEASE_BASE_URL` to the fork's release download base in its service
   environment and restart its service. **Update everything** is safe only once every connected host
   has loaded that setting: a host without it installs upstream's same-version archive, which a later
   update will not replace with the fork. The update queue waits for active sessions; it does not
   build or publish releases. Publishing alone never updates a host.
4. Once the hosts are idle and the release has been accepted, run `prune <host> --confirm-idle` or
   `prune --all --confirm-idle`.
5. Use `status` to read active versions, service state, installed version directories, launcher
   paths, release-base overrides, cold backups and the published fork release.

Keep the upstream version tag pointing to its original upstream commit, not the fork build commit.
Release retention leaves **exactly one GitHub fork release**, deleting older releases but keeping
their tags. Successful publication removes the selected hosts' version caches and the Mac's transfer
cache, not the ignored checkout build output. The Mac coordinates these archives; it does not
cross-build them.

### Release-notes receipt

The coordinator writes the fork SHA, upstream nightly, generic builder roles and migration changes
into release notes. Never substitute private host identities or paths. Preserve the generated
machine-readable receipt: rollback requires exactly one HTML comment with single-line JSON in
this format (angle-bracket values below are placeholders):

```html
<!-- t3-host-release {"schemaVersion":1,"forkSha":"<full-lowercase-40-character-sha>","upstreamTag":"v<release-version>","builders":[{"platform":"win32-x64","role":"primary"},{"platform":"linux-x64","role":"primary"}],"migrations":{"<previous-version>":false}} -->
```

Builder roles are `primary` or `fallback-N`, not inventory names. The migration map compares each
reachable host's pre-release version with the release commit's upstream migration files: `true`
means changed, `false` means unchanged. A missing target entry means unknown compatibility, not
permission to roll back. The receipt tag must match the published release tag; missing, duplicate
or invalid receipts refuse rollback. Do not invent a receipt to bypass a refusal.

## Release source and availability

The fork CLI uses fork releases by default for discovery and archive downloads, including self-update,
pinned runtimes and SSH-tunnel installs. `T3CODE_RELEASE_BASE_URL` remains a download-base override.
An upstream server making its first transition to the fork needs that override set to the fork's
release download base in its service environment before restarting and updating.

Connected servers target the newest published, non-draft release on the app's channel no newer than
the app version, selected by version rather than API order. Servers at or past that target are
current; an unavailable release produces no update offer. Boot-service installs consume archives;
npm-based servers must also wait for the version to be published on npm.

An SSH-tunnel install requesting a version absent from fork releases fails with **No release
archive**. Publish the missing fork archive; do not silently fall back to upstream. Explicit
rollback recovery is a separate operation, not an installation fallback.

## Fixed executable path

Host services run `<T3 home>/runtime/current/t3.exe` on Windows and `<T3 home>/runtime/current/t3`
on Linux, so Windows Firewall rules and VPN split-tunnel exclusions that match an exact executable
keep working across updates. `runtime/current` holds hard links to the active version directory and
uses no extra disk. The launcher points it at the version it is about to start, while no server
runs: on updates, automatic trial rollbacks and restarts. The launcher's own replaced image waits in
`runtime/.current-retired` until it has exited.

An in-app update replaces the server but never the launcher or the service file. A host whose
service file still names `runtime/versions/<version>` moves on its own: the first updated server
started by that launcher rewrites the `.cmd` launcher line (padded to the same length, because cmd
resumes a running script at a byte offset) or the unit's `ExecStart` (then `daemon-reload`), and
exits once. The supervisor restarts the launcher from `runtime/current`, so the update costs one
extra restart. `runtime/.current-move-attempt` records the version that tried, so a supervisor that
still starts the old launcher costs one restart rather than a loop; `prune` and `rollback` also
migrate. `status` reports the launcher directory, and `launcherVersion` is the version
`runtime/current` holds.

## Pruning and safe service stops

Only prune or roll back an idle host; both commands require `--confirm-idle`. That flag is the
operator's confirmation, not an active-session check. A restart interrupts agent turns and
terminals, so run maintenance from the Mac rather than from a turn hosted on the server being
restarted. Maintenance requires exactly one published, non-draft fork release, and every selected
host must be running that release with no pending update. Unlike release preflight, maintenance
does not skip unreachable hosts.

Pruning takes a fresh cold backup of the current version while the service is stopped, even if a
same-version backup already exists. It includes `statev2.sqlite`, any WAL/SHM sidecars, service state,
the service file and a checksum receipt. It fills `runtime/current` with the active version, points
the service file at its launcher, restarts and confirms that version is running before deleting
other version directories and all older backups. Successful pruning keeps exactly one installed
version and that one fresh backup. Never delete a directory still named by an older service file,
even if its launcher currently starts a newer server. The retained backup is a current-version recovery point, not a pre-migration
snapshot. A rollback keeps a backup of the newer version it left; prune refuses before stopping
anything while such a backup exists, so remove it deliberately once the rollback is settled.

Before stopping, maintenance requires enough free space for the copied files plus headroom of twice
their size or 256 MiB, whichever is larger; an unavailable space reading also refuses maintenance.
Cold backups are copied into sibling `.cold-staging-*` directories, flushed and validated before
being renamed to their final names. `status` reports leftover staging directories in `stagingBackups`
and individual invalid backups in `backupErrors` without hiding live-state facts. Either condition
blocks maintenance before stopping; staging directories are never removed by retention. Inspect
leftovers deliberately before proceeding. Existing backups are preserved if the space check fails.

- **Windows:** start from the recorded runtime PID in `userdata/server-runtime.json` and inspect its
  parent ancestry to identify the service's `conhost`. Stop that exact tree with
  `taskkill /PID <confirmed-conhost-pid> /T /F`, then stop and start the named Task Scheduler task with
  `schtasks /end /tn <task-name>` and `schtasks /run /tn <task-name>`. Stopping only the task can leave
  the launcher loop alive. Refuse to proceed if the ancestry cannot be established.
- **Linux:** stop and start the configured user systemd unit with `systemctl --user stop <unit>` and
  `systemctl --user start <unit>`. After changing the unit file, run `systemctl --user daemon-reload`
  before starting it again.

Never kill by process name, command-line pattern or checkout path. Use the identified service tree
or service manager, and preserve the service configuration and runtime state before changing them.

## Rollback and data safety

A failed update trial automatically returns to the previous version and restores the launcher's
backup. Read `boot-service.log` for the failure; do not intervene while the trial is still running.

Before pruning, `rollback <host> --confirm-idle` selects the previous committed version recorded in
service state and requires it to remain installed. Explicit `rollback <host> --to <version>
--confirm-idle` can recover a missing runtime from upstream, but only while upstream still publishes
its archive and `SHA256SUMS`. Missing archives are downloaded, verified and installed before the
service stops. Old fork release assets are not retained; an old tag does not guarantee an archive.

Both forms require an older target and a receipt on the current published fork release explicitly
recording unchanged upstream migrations for that target. Explicit upstream recovery does not bypass
this gate. Changed or unknown migration compatibility refuses before stopping and prints retained
backup paths, or reports that none exists. The tool never restores userdata. Any database restore
is a separate manual recovery requiring the owner's go: identify a compatible pre-migration
recovery point, stop the service, and accept the loss of changes made after that backup. Never run
older code against a post-migration backup. After pruning past a migrating release, fix forward.

An allowed rollback keeps the current database, takes a fresh stopped backup, fills
`runtime/current` with the target version and changes `activeVersion` in `runtime/service-state.json`, clearing the old update record. It also
removes a recognized standalone fork `T3CODE_RELEASE_BASE_URL` line from the service file, so an
upstream runtime's discovery and downloads agree. A nonstandard override line refuses before
downloading a missing runtime or stopping rather than being guessed at. Service rewrite checks,
unfinished-transition checks and backup preflight all run before an upstream download. The command
confirms the target version after restarting; the Mac app is unaffected.

An emergency same-version reinstall is manual: with explicit operator approval, stop the service,
move the installed version directory aside, extract the replacement archive with its
`.install-complete` marker, delete `runtime/current/.install-complete` so the launcher relinks the
replacement, and start again. This bypasses the launcher's trial protection; preserve
a cold backup and prefer a newer release instead.

## Exit status and interrupted work

The coordinator uses `0` for success, `1` for command or I/O failure, `2` for usage errors, `3` for
preflight refusal, and `4` when maintenance or publication may be partial. These codes describe the
coordinator; the standalone archive builder reports failures as `1`.

On `4`, do not blindly rerun. Inspect `status`, the affected service state and launcher, retained
backups, published releases and named version caches as applicable. A service may still be stopped,
publication may have succeeded without finishing retention, or only some selected hosts may have
completed maintenance. No automatic repair is attempted. Establish what completed before choosing
recovery; a database restore still needs the owner's go.
