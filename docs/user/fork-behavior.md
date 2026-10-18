# Where ndev.t3code differs from T3 Code

A few upstream features behave differently in this fork. The upstream guides describe T3 Code as
released; this page lists the differences.

## New threads start without a project

The sidebar's new thread button and `mod+n` (`chat.new`) start a thread
[without a project](thread-sidebar.md#start-without-a-project). Where your machine offers no
project-free folder, `chat.new` may ask you to choose a project instead. To start in the current
project with your [new-thread defaults](thread-sidebar.md#start-a-thread), Shift+click the button
or press `mod+shift+n` (`chat.newLocal`). `chat.newWithoutProject` (`mod+alt+n`) always starts
without a project.

## Connected servers follow published fork releases

In the web and desktop clients, connected servers running the fork update to the newest published,
non-draft fork release on the app's channel that is no newer than the app itself. Releases are
compared by version, not by publication order. A release built from a newer fork commit at the
same upstream version also counts as an update; rows show it as the version plus `(fork <commit>)`.

A desktop app built from the fork's source keeps the hosts in step with it. A source sync pushes
the fork, which pulls the new code onto every host. **Update** pushes before it starts building and
publishes a host release, so the hosts build as soon as you click it, alongside the app. It then updates each
connected fork host right away, even to a release newer than the app, without waiting for the host
to be idle. If publishing fails, an error notice names the log and offers **Retry**. Each host is updated once per
release, so after a failed update, use the server's update action instead.

Use **Update everything** or the server's update action to update a server now. If the release
cannot be found, no server update is offered; the app does not ask a server to install an
unpublished version. Boot-service installations use release archives. npm-based servers still
need that version to be available on npm before they can update.

If **Update everything** cannot start a server's update, for example because that server is
already updating or its connection dropped, the server is listed as failed and **Retry** offers it
again, instead of being counted as updated.

Each server reports where it installs releases from: fork releases, upstream releases, or a custom
mirror set with `T3CODE_RELEASE_BASE_URL`, which must use `https://`. **Settings → Connections**
shows it with the version and channel on every host row, and the row's tooltip adds when the
server started. **Update everything** and **Update all** update only fork hosts and list the
others with the reason; a host's own update action still works but asks first. A server too old to
report its source counts as unknown: update it once from its row. If the release check fails,
Connections shows **Couldn't check fork releases** with the reason, such as the GitHub rate limit
or being offline, and a **Retry**. A host's **Backups…** menu item lists the backups the host
tooling keeps and the version each would restore; restoring stays a host-side step.

The native mobile client's release check works differently: it uses the connected server's channel
and the first matching non-draft release in the release listing, not the web/desktop version cap
or version sorting. It offers that release only if it is newer than the server. Mobile updates do
not use the web client's maintenance queue and may interrupt running threads.

The legacy sidebar's update button updates only the desktop app, not connected servers or
providers. It asks for confirmation before installing, but skips the standard sidebar's fresh
active-session check. The desktop app can still hold the restart while sessions are busy. Use
the standard sidebar's **Update everything** for coordinated updates.

## Host services keep one executable path

A background service runs `~/.t3/runtime/current/t3` (`t3.exe` on Windows), and that path stays
the same across updates and rollbacks. Point firewall rules and VPN split-tunnel exclusions that
match an exact program at it. A service installed by an older version moves to this path by
itself on its next update, including one started from the app; T3 restarts one extra time then.
After each update the service also restarts its launcher onto the new version if needed, then
removes the older versions and the update's leftovers by itself.

## Tailscale HTTPS needs HTTPS certificates

[Tailscale HTTPS](remote-access.md#tailscale-https) needs **HTTPS Certificates** turned on for your
tailnet, on the DNS page of the Tailscale admin console. Until then, the route in **Settings →
Connections** says so.

## Thread details sections collapse

In the thread details card, choose a section's title, such as **Automations** or **Lineage**, to
collapse it to its heading, and again to expand it. Each section remembers its state across
threads and restarts. See [Session details](session-details.md#open-them).

## Saved connections stay out of the macOS keychain

On macOS, the desktop app encrypts saved connections with a key in `desktop-secrets` under your T3
home's `userdata` folder, readable only by your account, so updates no longer ask for your
keychain password. The first launch after this change asks once more, to move connections saved
in the keychain. Once that is done, you can delete the app's **Safe Storage** item in Keychain
Access. Windows and Linux are unchanged.

## Thread cards name their machine

Every thread card in the sidebar names the machine the thread runs on, the one picked in **Run
on**, centered at its bottom, even when the thread is in a project, since one project can live on
several machines. A thread's branch, when it has one, sits at the bottom left.

## Subagents sit under their thread

A thread that started subagents, through `delegate_task` or the provider's own subagent tool, shows
an arrow and a count of all its subagents, nested ones included, at its bottom left in the
sidebar, wherever the thread sits: Active, Working, Snoozed or Settled. Click it to list its
subagents as single lines under the thread, newest first at every level, and again to collapse
them. Collapsed, the thread still lists the subagents that are running and the one you have open,
like the Other Agents and Hermes shelves; one shown without its parent is not indented. Expanded,
the first three are listed, plus any that are running or open, and **Show more** lists the rest.
They stay there after they finish. Hover one for its provider, model and status; open it to
review its work, or right-click it to archive or delete it.

The thread details **Lineage** section lists every subagent below the thread too, not only the
ones it started directly, each indented under the agent that started it, newest first. A tree
stays together: while anything in it is working it stays in the main list, and only fully
finished trees move under **Previous agents**. Subagent rows there, workflow groups included, use the
sidebar's compact size.

## Other Agents across machines

The Other Agents shelf lists each machine's 60 newest sessions. When a machine has more, the
**Earlier** header shows "60 of N"; expand **Earlier** and choose **Browse older** to load the
next 60. Nothing older loads until you ask. When more than one machine is connected, each session
row and every Other Agents search result, in the sidebar and the command palette, names its
machine.

If a machine doesn't answer a search, because it timed out, dropped its connection or runs an
older server, the results header says how many were searched, such as "Other Agents (12) ·
searched 2 of 3 hosts", and its tooltip names the one that didn't answer. With no matches it reads
"No matches · Studio didn't answer", so a missing machine is never mistaken for no matches.

## Actions a connection can't run are hidden

A connection paired with limited access, for example without operate or provider management
access, hides the fork's actions the server would refuse instead of letting them fail: continuing,
archiving, handing back or opening Other Agents sessions, Hermes session and settings changes,
**Save to notes**, comparisons, and releasing provider sessions before an update. Where a whole
settings section is unavailable, it says which access it needs.

## Codex can show hidden models

OpenAI keeps some models out of the Codex picker, such as older or long-context versions. To list
them in the model picker too, turn on **Show hidden models** in the Codex provider's settings,
under **Settings → Providers**. It is off by default, so the picker matches the Codex app.

## Pi model names match the vendor's

Pi's provider groups use brand names, such as **Codex**, **Gemini** and **OpenRouter**, rather
than ids like `openai-codex`. Codex models under Pi are named as OpenAI writes them, such as
**GPT-6.1-Sol**.

A model whose name starts with its group's name and a space, such as **Grok 4.20** under
**Grok**, keeps its full name; T3 Code would show it as **4.20**. A name with punctuation after
the group's name, such as **OpenCode Zen: Step 5**, is still shortened to **Step 5**.

## Retired models move to their successor

When a provider replaces a model with a newer id, saved choices follow it. Pi's **OpenAI** models
replace the legacy `openai-codex` ones, so once Pi reports that you are signed in, a default,
worker, preset, project or text generation model saved as `openai-codex/gpt-6.1-sol` becomes
`openai/gpt-6.1-sol`. Hidden models, model order and favorites move the same way.

A saved model that the provider no longer lists and that has no successor stays as it is. Model
pickers in Settings show it as **Unavailable**, so you can see what still runs and pick another.

## Status colors mean the same thing everywhere

Green means connected or live, blue means in progress, amber means it needs attention, red means
it failed, and grey means off or idle. So in **Settings → Connections**, each environment shows a
status dot, and a pairing link that is waiting to be used is blue rather than amber. A sidebar
thread that is waiting on background work is blue, because that work is still running. In
**Usage**, the period buttons show no selection while **Limits** is shown, since limits ignore the
period. Pooled account bars in **Limits** also show an even-spending marker: a remaining-allowance
bar ending to its right means you are using less than an even share of the period; to its left
means you are using more. It is hidden when the period's timing is unknown or within the first or last 2% of
the period. Weekly and monthly durations may be inferred from the reset date when the provider
omits them.

The same holds in **OpenTelemetry export** in **Settings → Diagnostics**: an endpoint check in
progress is blue, and a check that could not run says **Check failed** in red, with the reason on
the dot. **Settings → Archive** leaves out "No archived threads" when archived Other Agents or
Hermes sessions are listed below it.
