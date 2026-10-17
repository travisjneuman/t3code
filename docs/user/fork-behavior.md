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

Connected servers running the fork update to the newest published, non-draft fork release on the
app's channel that is no newer than the app itself. Releases are compared by version, not by
publication order. A server already at or past that target counts as current, even if the app has
had another source update since the last host release.

Use **Update everything** or the server's update action when a release is offered. If the release
cannot be found, no server update is offered; the app does not ask a server to install an
unpublished version. Boot-service installations use release archives. npm-based servers still
need that version to be available on npm before they can update.

## Tailscale HTTPS needs HTTPS certificates

[Tailscale HTTPS](remote-access.md#tailscale-https) needs **HTTPS Certificates** turned on for your
tailnet, on the DNS page of the Tailscale admin console. Until then, the route in **Settings →
Connections** says so.

## Thread details sections collapse

In the thread details card, choose a section's title, such as **Automations** or **Lineage**, to
collapse it to its heading, and again to expand it. Each section remembers its state across
threads and restarts. See [Session details](session-details.md#open-them).

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
period.

The same holds in **OpenTelemetry export** in **Settings → Diagnostics**: an endpoint check in
progress is blue, and a check that could not run says **Check failed** in red, with the reason on
the dot. **Settings → Archive** leaves out "No archived threads" when archived Other Agents or
Hermes sessions are listed below it.
