# Where ndev.t3code differs from T3 Code

ndev.t3code is an unofficial fork of [T3 Code](https://github.com/pingdotgg/t3code). The T3 Code
guides describe the app as upstream releases it. This page lists every way the fork behaves
differently, plus the small additions that have no guide of their own. Bigger additions have their
own guides, listed in the [user guides](README.md) as _fork add-on_.

## What is different about the fork

- **It installs beside T3 Code.** The desktop app is named ndev.t3code and has its own app
  identity, profile and `t3code-tjn://` links, and its own app and web icons, so it can sit next to
  the official app. Its server keeps its data in `~/.t3`, like the official app, so threads,
  settings and providers carry over. Run one of the two at a time.
- **Updates come from source.** The desktop app builds itself from its source checkout and merges
  each new upstream nightly into it. It doesn't use upstream's download feed. See
  [Build and update ndev.t3code](fork-updating.md).
- **Changes go one way.** The fork only takes changes from upstream. It never pushes to the
  official repository or opens pull requests or issues there.
- **Reporting problems.** The T3 Code maintainers don't support the fork, and the fork has no issue
  tracker. Never report a fork add-on's behavior to upstream. If you think a problem is upstream's,
  reproduce it in official T3 Code first.
- **The mobile app is unchanged.** Phones use upstream's T3 Code app and connect to fork servers as
  they would to any T3 Code server. Fork-only features are on web and desktop.
- **Additions are add-ons.** Each fork feature or fix is a separate add-on that lives in its own
  files and touches upstream code only through small marked hooks, so each upstream merge stays
  small. See [Fork add-ons](../internals/fork-add-ons.md).

**Settings → About** lists, under **Fork add-ons**, the add-ons the connected server was built
with.

## Outside agents without OAuth can connect

[Outside agents](outside-agents.md) says agents without OAuth support can't connect. In the fork,
`t3 mcp token` issues a revocable token at an access level you choose, for agents that take a URL
and an `Authorization` header. `t3 mcp stdio` serves agents that only speak stdio. See
[Use T3 Code as an MCP hub](mcp-hub.md).

## New threads start without a project

The sidebar's new thread button and `mod+n` (`chat.new`) start a thread
[without a project](thread-sidebar.md#start-without-a-project). If your machine has no
project-free folder, `chat.new` may ask you to choose a project instead. To start in the current
project with your [new-thread defaults](thread-sidebar.md#start-a-thread), Shift+click the button
or press `mod+shift+n` (`chat.newLocal`). `chat.newWithoutProject` (`mod+alt+n`) always starts
without a project.

To start new threads in a project instead, open it in **Settings → Projects** and turn on
**Start new threads here**. The button and `mod+n` then start there, on the current thread's
machine when the project is on it. The choice is kept on this device. Turn it off to go back to
starting without a project.

## Connected fork hosts follow the desktop app's local builds

Fork hosts update only to the version the source-built desktop app's last successful host build
staged. **Sync & Build** pushes the fork, then builds the Mac app and every host in your private host
inventory in parallel, from the same commit. Each host builds and stages its own server
([fork host builds](../operations/fork-host-releases.md)). Hosts build only when that push
succeeds. Without that inventory, host builds are off and **Sync & Build** only builds the app.

Hosts wait for the Mac. Once every configured host has staged the build and this Mac app runs it
(after **Restart & Install**), the app updates each connected fork host that runs as a background
service. A build that breaks the Mac never reaches the hosts. Until then the hosts keep their
current build, and **Update everything** or a host's own update action can still update them. List
every host you connect in the inventory: a connected host outside it is offered the same version
without having staged it.

If a host build fails, a notice names the log and offers **Retry** for the same commit, and the
host's row says **Local host build failed** with the reason. After you fix the cause, the update
button retries that build too, so the hosts follow it instead of being skipped. When the Mac app
has its own update waiting, that update builds a new commit for the hosts instead. Rows show a fork build as the version
plus `(fork <commit>)`. The desktop app's own server is never compared with a host build. It ships
inside the app, so it offers a server update only when its version differs from the app's.

Until a staged build exists, no fork host update is offered. Web clients without the desktop app
never offer one. A server installed from npm updates only from npm, where the fork publishes
nothing, so it never moves to a fork build.

If **Update everything** can't start a server's update, for example because that server is already
updating or its connection dropped, the server is listed as failed and **Retry** offers it again.
It isn't counted as updated.

Each server reports its release source: fork builds, upstream releases, a custom release source,
or not reported by an older server. **Settings → Environments** shows it with the version and
channel on every host row, and the row's tooltip adds when the server started. **Update everything**
and **Update all** update only fork hosts and list the others with the reason. A host's own update
action still works on the others, but asks first, since they install upstream T3 Code. A server too
old to report its source counts as unknown: update it once from its row.

A host's **Backups…** menu item lists the backups the host's own tooling keeps and the version each
would restore. Restoring stays a step on the host. The item shows only on hosts that report backups.

### Where servers download releases from

A server that updates from releases looks for them in the repository set by
`T3CODE_RELEASE_REPOSITORY`, as `owner/name`. If that isn't set, it takes the repository from
`T3CODE_RELEASE_BASE_URL` when that is `https://github.com/<owner>/<name>/releases/download`, and
otherwise uses `travisjneuman/t3code`. Downloads come from that repository's GitHub releases.
`T3CODE_RELEASE_BASE_URL` overrides where downloads come from and can name your own mirror, which
must use HTTPS. When both are set and the base is a GitHub releases URL, it must name the same
repository, or updates stop with an error. The fork publishes no GitHub releases of its own, so a
server that updates from releases needs one of these set to a repository or mirror that has them;
otherwise update it through the desktop app's host builds above.

A server the desktop app starts over SSH downloads the app's own version. It uses
`T3CODE_RELEASE_BASE_URL` from the environment the desktop app starts in, and otherwise the
`travisjneuman/t3code` releases.

## Host services keep one executable path

A background service runs `~/.t3/runtime/current/t3` (`t3.exe` on Windows), and that path stays
the same across updates and rollbacks. Point firewall rules and VPN split-tunnel exclusions that
match an exact program at it. A service installed by an older version moves to this path by itself
on its next update, including one started from the app; T3 restarts one extra time then. After each
update the service restarts its launcher onto the new version if needed, then removes older
versions and the update's leftovers.

## Updates run at once

Server and provider updates on other machines start as soon as you ask for them. Only work running
on this machine holds an update back. See
[Updates run at once](fork-updating.md#updates-run-at-once).

## Full-tunnel VPN addresses aren't offered as LAN addresses

A machine on a full-tunnel VPN (Proton VPN, WireGuard, OpenVPN) has a private address on the tunnel
that no other device can reach. T3 leaves such tunnel addresses out of the addresses a server
advertises and pairs with, and keeps the Tailscale address. On Windows, a Hyper-V external switch
that carries the machine's network connection counts as its LAN adapter; only the WSL and Default
Switch adapters are skipped.

## Tailscale HTTPS needs HTTPS certificates

[Tailscale HTTPS](remote-access.md#tailscale-https) needs **HTTPS Certificates** turned on for your
tailnet, on the DNS page of the Tailscale admin console. Until then, on the desktop app, the route
in **Settings → Sharing & access** says so.

## Pair a phone with any connected machine

A phone sees only the machines it is paired with, so threads started on another machine from the
desktop app don't show on the phone until it pairs with that machine too. To pair without signing
in at that machine, open **Settings → Environments**, choose **Pair a device…** in the machine's
**⋯** menu, and scan the QR code with the mobile app. The link works once, for 5 minutes. It uses
the machine's Tailscale HTTPS address when it has one, otherwise its tailnet or local network
address, so the phone must be able to reach that address. The item shows only for a connected
machine that reports its own addresses, and only when your connection may manage its access.

## Renamed machines keep their new name

On web and desktop, a saved environment takes the name its machine reports each time it connects,
so renaming a machine renames it in **Settings → Environments** and everywhere else the app names
it. The mobile app keeps the name you gave it.

## Saved connections stay out of the macOS keychain

On macOS, the desktop app encrypts saved connections with a key in `desktop-secrets` under your T3
home's `userdata` folder, readable only by your account, so updates no longer ask for your keychain
password. The first launch after this change asks once more, to move connections saved in the
keychain. After that you can delete the app's **Safe Storage** item in Keychain Access. Windows and
Linux are unchanged.

## Sessions and links last ten years

Upstream signs a paired app out after 30 days, and
[a link to another environment](remote-access.md#link-another-environment) lasts 30 days. In the
fork both last 3,650 days. Change it under **Session lifetime** in **Settings → Maintenance**. The
setting is stored on each machine, so leave **All environments** selected to change every connected
machine at once. The lifetime is fixed when a session starts: pair or link again to give an existing
session the new one. To end a session sooner, revoke it in **Settings → Sharing & access**.
[Outside agents](outside-agents.md) signed in through OAuth keep upstream's 30 days.

## Actions a connection can't run are hidden

A connection paired with limited access, for example without operate or provider management
access, hides the fork's actions the server would refuse instead of letting them fail: continuing,
archiving, deleting, handing back or opening Other Agents sessions, Hermes session and settings
changes, opening OpenBot conversations, **Save to notes**, comparisons, and releasing provider
sessions before an update. Where a whole settings section is unavailable, it says which access it
needs.

## Compact thread cards that name their machine

Sidebar thread cards are outlined and smaller than upstream's, with text one size down. Every card
names the machine the thread runs on, the one picked in **Run on**, centered at its bottom, even
when the thread is in a project, since one project can live on several machines. The thread's
branch, when it has one, sits at the bottom left, and its status, pull request and changes at the
right. Section headers stay at full contrast. In a narrow sidebar, the footer's icon buttons get
smaller so they all fit. The preview panel keeps one width for every thread and Other Agents
session instead of one per thread.

## Subagents sit under their thread

A thread that started subagents, through `delegate_task` or the provider's own subagent tool, shows
an arrow and a count of all its subagents, nested ones included, at its bottom left in the sidebar,
wherever the thread sits: Active, Working, Snoozed or Settled. Click it to list its subagents as
single lines under the thread, newest first at every level, and again to collapse them. Collapsed,
the thread still lists the subagents that are running and the one you have open, like the Other
Agents and Hermes shelves; one shown without its parent is not indented. Expanded, the first three
are listed, plus any that are running or open, and **Show more** lists the rest. They stay there
after they finish. Hover one for its provider, model and status; open it to review its work, or
right-click it to archive or delete it. The count includes idle subagents the server leaves out of
the sidebar to keep it light; expanding the thread loads them. An older settled thread that loads
later as you page through Settled counts only the subagents already loaded.

The thread details **Lineage** section lists every subagent below the thread too, not only the ones
it started directly, each indented under the agent that started it, newest first. A tree stays
together: while anything in it is working it stays in the main list, and only fully finished trees
move under **Previous agents**. Subagent rows there, workflow groups included, use the sidebar's
compact size.

## Thread details sections collapse

In the thread details card, choose a section's title, such as **Automations** or **Lineage**, to
collapse it to its heading, and again to expand it. Each section remembers its state across threads
and restarts. See [Session details](session-details.md#open-them).

## Selected threads get the whole thread menu

Right-click one of several selected threads (Cmd/Ctrl-click or Shift-click to select them) and the
menu offers what a single thread's menu does, each over the selected threads it applies to: pin and
unpin, settle and un-settle, snooze and wake, auto-settle, title regeneration, mark unread, archive
and delete, copying their paths, branches or thread IDs (one per line), export and save to notes,
and hand back or move back for continued threads. Threads in one project add its filter and project
settings; threads on one branch and worktree add a new thread there; the two sides of one comparison
add **Open comparison**. Rename stays one thread at a time.

## Settled and archived threads clean themselves up

Each machine moves threads along on its own: a thread that has been settled for 7 days is archived,
and one that has been archived for 7 days is deleted. A deleted thread's history is removed from
disk a day later. Pinned threads, and threads with running work, pending requests or an enabled
scheduled task, are never moved. Change either number of days, or turn a step off, in
**Settings → Archive → Retention**. Unarchive or un-settle a thread to keep it.

Subagent and coworker threads go with the thread that started them. Archiving, unarchiving or
deleting a thread, by hand or by retention, does the same to its subagent threads at every depth. A
subagent that is still working, pinned or scheduled is left alone until it is free, and it also
holds its parent back from automatic archiving and deleting.

**Settings → Archive** also shows how much disk space each machine's T3 Code data uses (its database
and attachments), split into settled, archived and other threads, and the size of each settled and
archived thread, its subagent threads included, with how many it has. Settled threads are listed
there too, with **Unsettle**, **Archive** and **Delete**, including older ones the sidebar's Settled
shelf hasn't loaded. Archived threads follow under their own heading, grouped by project; a subagent
thread is listed only when it was archived without its parent. "No archived threads" is left out
when archived Other Agents or Hermes sessions are listed below it.

## Other Agents across machines

The Other Agents shelf merges every connected machine's sessions into one list, newest first. It
first shows the last 3 days; **Load more** adds the next 10, whichever machine they ran on, back to
the 14 days each machine lists (Codex threads stay until archived). When more than one machine is
connected, each session row and every Other Agents search result, in the sidebar and the command
palette, names its machine.

The command palette searches other agents' sessions alongside T3 threads
([Search other agents' sessions](other-agents.md#search-other-agents-sessions)). If a machine
doesn't answer a search, because it timed out, dropped its connection or runs an older server, the
results header says how many were searched, such as "Other Agents (12) · searched 2 of 3 hosts",
and its tooltip names the one that didn't answer. With no matches it reads
"No matches · Studio didn't answer", so a missing machine is never mistaken for no matches.

## One project on several machines

Git projects already show as one project across machines when they share a repository. For a folder
that isn't a git repository, open it in **Settings → Projects** and use **Link with a project on
another machine** under **Checkouts**: both then show as one project, each machine keeping its own
folder, and project settings apply to both. **Unlink** next to a machine's checkout splits it off
again, and **Remove** removes that machine's copy. Links are stored on each machine's server, so
every client and device sees them. A machine on an older release shows its copy on its own until it
updates.

**Checkouts** also lists each connected machine that doesn't have the project yet. For a git
project, **Add…** opens **Add to another machine**. For a folder project, enter the folder on that
machine (it must already exist) and press **Add**; the new copy is linked automatically.

When **Add to another machine** finds the repository already checked out on that machine, in its
add-project folder, beside its other projects, or one level below either, it offers to add that
folder instead of cloning a second copy. If the checkout is somewhere else, choose **Use a folder
already there** and enter its folder; it is added only if it is a checkout of the same repository.

To pick up git projects you already have checked out on other machines, use **Find projects on
other machines** in **Settings → Projects**, or the same command in the command palette. It searches
each connected machine that lacks a project, in its add-project folder and beside its other
projects, lists what it found for you to tick, and adds those folders. It never clones; a project it
didn't find gets an **Add on…** shortcut. The search reads each machine's disk, so it only runs when
you press **Search**.

**No project** shows once in Settings and the command palette, as in the sidebar, and can't be
removed: every machine keeps its own.

A project's icon follows it to every machine. Upstream writes an icon to the checkouts connected
when you pick it, so a machine added later shows the plain monogram. Here a checkout with no icon of
its own shows the one chosen on another machine's checkout of the same project. An image icon is
read from each machine's own checkout by the same path, so it shows where that file exists.
Checkouts that were given different icons keep their own.

## Built-in providers can be removed from the list

Built-in providers other than Codex and Claude, such as Cursor, OpenCode, Muse Code or Grok, have a
delete button in their settings under **Settings → Providers**. Deleting one clears its settings,
turns it off and takes it out of the list. To bring it back, choose it under **Add provider**.

## All environments in Settings → Providers

Choose **All environments** at the top of **Settings → Providers** to change a provider on every
connected machine that has it. The page shows the first connected machine's values, and each change
you make there is applied on the others too: turning a provider on or off, its settings, hiding,
showing, reordering and favoriting models, custom models, project overrides, the health check
interval, refreshing, provider updates, and installing or updating the Antigravity runtime.
Removing a provider or resetting it to its defaults also applies on the others, and the
confirmation names them. Paths, launch arguments, API keys, environment variables and sign-in stay
per machine.

Each provider's page lists every machine that has it, with its version, whether it is on, and
whether an update is waiting. **Match** _machine_ **everywhere**, named for the shown machine,
copies its on/off state and model preferences to machines that differ, and **Update everywhere**
starts every waiting update.

A machine that is offline when you make a change keeps its old setting; change it again once it
reconnects. Adding a provider, usage limits, web apps and text generators are saved only on the
shown machine, and removing a registry provider uninstalls its runtime only there. The mobile app
changes one machine at a time. Pick a single machine at the top of the page to change only that one.

## Wrapper scripts can name the install they run

If a provider's command is your own script that wraps a package-manager install, for example to set
environment variables before running Codex, T3 Code can't see the install behind it and asks you to
update it yourself. Add a line naming the install's command anywhere in the script, and T3 Code's
update button updates that install:

```sh
# t3-update-target: /home/me/.npm-global/bin/codex
```

In a Windows `.cmd` script, start the line with `rem`. The path must be absolute, and the script
must be under 16 KB.

## Codex can show hidden models

OpenAI keeps some models out of the Codex picker, such as older or long-context versions. To list
them in the model picker too, turn on **Show hidden models** in the Codex provider's settings, under
**Settings → Providers**. It is off by default, so the picker matches the Codex app.

## Pi model names match the vendor's

Providers and models use their vendors' names. Pi's provider groups show brand names, such as
**Codex**, **Gemini** and **OpenRouter**, rather than ids like `openai-codex`, and Hermes and
OpenBot name models the same way. Codex models under Pi are named as OpenAI writes them, such as
**GPT-6.1-Sol**.

A model whose name starts with its group's name and a space, such as **Grok 4.20** under **Grok**,
keeps its full name; T3 Code would show it as **4.20**. A name with punctuation after the group's
name, such as **OpenCode Zen: Step 5**, is still shortened to **Step 5**.

## Retired models move to their successor

When a provider replaces a model with a newer id, saved choices follow it. Pi's **OpenAI** models
replace the legacy `openai-codex` ones, so once Pi reports that you are signed in, a default,
worker, preset, project or text generation model saved as `openai-codex/gpt-6.1-sol` becomes
`openai/gpt-6.1-sol`. Hidden models, model order and favorites move the same way.

A saved model that the provider no longer lists and that has no successor stays as it is. Model
pickers in Settings show it as **Unavailable**, so you can see what still runs and pick another.

## Status colors mean the same thing everywhere

Green means connected or live, blue means in progress, amber means it needs attention, red means it
failed, and grey means off or idle. So in **Settings → Environments**, each environment shows a
status dot, and a pairing link that is waiting to be used is blue rather than amber. A server update
that is resuming is blue. A sidebar thread that is waiting on background work is blue, because that
work is still running. A thread's scheduled automations show their last run as a colored dot, with
**Not run yet**, **Running**, **Last run succeeded** or **Last run failed** on hover. A provider
given an accent color shows a small dot in that color instead of its initials.

The same holds in **OpenTelemetry export** in **Settings → Diagnostics**: an endpoint check in
progress is blue, and a check that could not run says **Check failed** in red, with the reason on
the dot.

## Usage pace for weekly and monthly limits

Grok and Cursor report when a weekly or monthly limit resets but not how long the period is. The
fork works the length out from the reset date, so their bars in **Usage → Limits** get the
even-pace mark and pace icon like other providers'. When Grok leaves out how much of a limit is
used, the bar shows 0% used instead of nothing.

In **Usage → Limits**, a bar drawn in a provider's accent color stays visible when that color is
close to the background. A black accent shows as grey in a dark theme, and a white or pale accent
shows a shade darker in a light theme. The accent you picked in **Settings → Providers** is
unchanged.

## Usage shows one row per model

In **Usage → Breakdown → Model**, a model counts once however it ran. When it ran through more than
one route, such as Codex and Pi, or at a different context size, such as Claude Code's 1M context, a
sub-line under the row shows each route's cost and tokens, and the row's bar is split the same way.
Opening the model lists the routes again with their cost per 1M tokens and cache hit rate. Pi's
**Pi · OpenAI** route covers both an OpenAI API key and a ChatGPT sign-in, because Pi's transcripts
don't say which one was used. The Grok CLI reports Grok 4.7 as `grok-4.7-build`, so its usage joins
Pi's `xai/grok-4.7` under **Grok 4.7**, and its **Fast** variant counts as Fast speed of the same
model.

Usage that no model can claim, such as Pi's tools and summaries, sits under **Not tied to a model**
at the bottom, unranked.

**Set price** saves the price under the model's own name, such as `gpt-6.1-sol`, so it covers every
route of that model. A price saved for one exact route name, such as `openai-codex/gpt-6.1-sol`,
still wins for that route.

## Small fixes

- **Leave a crashing page.** When a page of the app crashes, **Go back** sits beside **Try again**
  and **Reload app**, so you aren't stuck on it.
- **Copy from a background window.** Copying works when the window isn't focused, for example from
  a right-click on a window behind another.
- **Desktop sign-in while the server settles.** The app keeps trying for up to 15 seconds when the
  desktop app's server answers with a temporary error as it starts.
- **macOS output errors.** The desktop app no longer crashes on macOS when the terminal or pipe its
  output goes to has closed.
- **Windows sessions stop cleanly.** Stopping an ACP agent on Windows counts as done once all its
  processes are gone, even when Windows reports a partial failure.
- **Antigravity behind a proxy.** Installing Antigravity works when proxy settings are in the
  environment.
- **Scheduled task deliveries.** When a scheduled task's delivery list fails to load, it shows the
  error without a loading line that never ends.
