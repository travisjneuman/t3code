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

Conflicts and build breaks that the merge can't settle on its own go to a repair agent. **Settings
→ Maintenance → Repair agents** lists the agents to try, in order, one per line: `pi` or `claude`,
a model, and an effort. The default is Pi on an Anthropic model, then Pi on an OpenAI model, then
Claude Code:

```text
pi anthropic/claude-opus-5-5 medium
pi openai/gpt-6.1-sol medium
claude claude-opus-5-5 medium
```

Pi uses the API keys it has stored (`pi auth login <provider> --api-key`), so its runs spend API
credit; Claude Code uses its own sign-in. An agent that isn't installed, isn't signed in, or has
run out of credit is skipped for the next line, so keep at least one that is ready where the app
can find it. Pi's repair sessions are saved like any other Pi session, named `t3 repair` and the
step, so they show under Other Agents and in Usage. The merge is committed and a push is attempted before
building, so configured fork hosts can build the same commit alongside this Mac. If the build
fails, the merge stays in place and the installed app is unchanged; the app attempts to stash
tracked repair edits as `local source update: unbuilt fixes`. Build fixes are committed only after
a successful build. If merging fails, the app attempts to abort the merge. Follow any cleanup
instructions in the error message and preserve any files it reports as left in the checkout before
retrying.

The app also checks for a new nightly a minute after it starts and every 30 minutes after that.
When one is out, it merges that nightly into `main` without building, and the update button then
offers **Sync & Build** for it. This background check never uses Claude Code: if upstream's
changes conflict with the fork's in a way it can't settle by itself, it skips that nightly until a
newer one is out or you press the merge button.

The merge button beside the update button (**Sync fork with official T3 Code**) merges everything
on upstream's `main` branch, including changes that are not in a nightly yet, without building.

When the checkout has commits the installed app wasn't built from but no newer nightly is out,
the update button says so and **Sync & Build** builds them at the current nightly's version.

Sync and update refuse to start while the checkout has uncommitted changes, is not on `main`, or
is in the middle of another merge.

### Pushing the merge

After a merge, the app pushes `main` to `origin`, and only when you can write to it. If the push
fails, the update reports the skipped push; the local merge stays in place and the build can
continue. It never pushes to `upstream`.

Fleet builds are optional and off without private `~/.config/t3code-fork/hosts.json`; its optional
top-level `"repository": "owner/name"` setting defaults to the checkout's `origin` ([setup](../operations/fork-host-releases.md)).

Other forks can enable upstream sync and nightly releases with repository variables `T3CODE_FORK_UPSTREAM_SYNC=true` and `T3CODE_FORK_NIGHTLY_RELEASE=true`, respectively; both exclude `pingdotgg/t3code`.

## Release feed

When source updates are off, for example on another platform or after the checkout was moved,
the app updates from GitHub Releases only if its build named a repository, as `owner/name`, in
`T3CODE_DESKTOP_UPDATE_REPOSITORY` or `GITHUB_REPOSITORY`. A local build without either has no
release feed; update it by pulling and building again.

For release-based server updates, set `T3CODE_RELEASE_REPOSITORY=owner/name` or
`T3CODE_RELEASE_BASE_URL=https://github.com/<owner>/<name>/releases/download` on the host;
update discovery follows that source.

## Updates run at once

A T3 server update and a provider update on another machine start as soon as they are asked
for, whatever that machine's sessions are doing. Threads a restart interrupts resume by
themselves when [Continue threads after restarts](updating.md#before-you-update) is on, which
is the default.

Two updates still wait, both for work running on this machine right now:

- The app's own restart into a new version waits while a session on this machine is running or
  waiting for an approval or your input, whoever asks for the restart, including **Update
  everything**, a remote client, or an agent. A Hermes Agent counts while its gateway is busy or
  any of its agents are running. Paused and stopped sessions hold nothing up.
- A provider update on this machine first closes that provider's idle sessions so it can restart
  cleanly, and waits only while one of them is in the middle of a turn.

A waiting update shows in the sidebar as **Waiting for N active sessions on** this machine's
name and runs as soon as they finish. **Update now** runs it right away; **Cancel** drops it, and
a downloaded app update stays ready for the update button. If an update is still waiting after 4
hours, you get one notification. A waiting app restart is forgotten if you quit the app.
