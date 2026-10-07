# Build and update ndev.t3code

ndev.t3code is an unofficial fork of [T3 Code](https://github.com/pingdotgg/t3code) with extra
desktop add-ons. Everything else works as the T3 Code guides describe, starting with
[Install T3 Code](./install.md). This page covers what differs: getting the fork's desktop app and
keeping it current with upstream.

## Build the desktop app

You need macOS, [Vite+](https://viteplus.dev/guide/) (`vp`), and at least one installed,
signed-in [provider](./install.md#providers).

```bash
git clone https://github.com/travisjneuman/t3code.git
cd t3code
vp i
vp run dist:desktop:dmg:arm64   # on an Intel Mac, use dist:desktop:dmg:x64
```

The app is saved in `release/`. Keep the checkout where it is after installing: the app
remembers the folder it was built from and updates from it.

The fork's desktop app has its own app identity, so it installs beside the official T3 Code app.
Its server keeps its data in `~/.t3`, the same place as the official app, so your threads,
settings, and providers carry over. Because they share that data, run one of the two at a time.

The fork does not publish regular desktop releases or package-manager builds; the package
managers in the T3 Code install guide install official T3 Code.

## Update from source

A packaged macOS build updates from its source checkout when that folder still exists and is a
git work tree. To use a different checkout, set `T3CODE_SOURCE_REPOSITORY_PATH` to its path in
the environment the app starts from.

The checkout needs two remotes:

- `upstream`, pointing at the official repository:

  ```bash
  git remote add upstream https://github.com/pingdotgg/t3code.git
  ```

- `origin`, pointing at your copy of the fork. It must not be the official repository.

When a new upstream T3 Code nightly is out, the update button and **Settings → General → About**
offer **Sync & Build** and name that nightly's version. **Sync & Build** merges the nightly into
the checkout's `main`, keeps the fork's additions, and builds the app on this Mac. Then **Restart
& Install** replaces the installed app with the new build and removes the old copy and the build
files.

Conflicts and build breaks that the merge can't settle on its own go to Claude Code, so install it
and sign in where the app can find it. Nothing is committed unless the new build succeeds. If the
merge or build still fails, the checkout is left as it was before the update and the message lists
the files involved.

The app also checks for a new nightly a minute after it starts and every 30 minutes after that.
When one is out, it merges that nightly into `main` without building, and the update button then
offers **Sync & Build** for it. This background check never uses Claude Code: if upstream's
changes conflict with the fork's in a way it can't settle by itself, it skips that nightly until a
newer one is out or you press the merge button.

The merge button beside the update button (**Sync fork with official T3 Code**) merges everything
on upstream's `main` branch, including changes that are not in a nightly yet, without building.
The update button builds them with the next nightly.

Sync and update refuse to start while the checkout has uncommitted changes, is not on `main`, or
is in the middle of another merge.

### Pushing the merge

After a merge, the app pushes `main` to `origin`, and only when you can write to it. If the push
fails, the local merge and build still complete, and the update reports that the push was
skipped. It never pushes to `upstream`.

## Release feed

When source updates are off, for example on another platform or after the checkout was moved,
the app updates from GitHub Releases only if its build named a repository, as `owner/name`, in
`T3CODE_DESKTOP_UPDATE_REPOSITORY` or `GITHUB_REPOSITORY`. A local build without either has no
release feed; update it by pulling and building again.
