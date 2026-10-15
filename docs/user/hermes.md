# Hermes Agent

_Fork add-on._ Chat with a [Hermes Agent](https://github.com/NousResearch/hermes-agent) from T3
Code. Hermes keeps running where it is, on this computer or another one, and T3 talks to its API
server over HTTP. Everything else Hermes is connected to, such as chat platforms, cron jobs and
its CLI, keeps working as before.

## Set it up

1. On the Hermes machine, turn on Hermes's API server and its web dashboard, and make both
   reachable from the computer running T3, for example over a tailnet. Give the API server a key
   (`API_SERVER_KEY`) and the dashboard a username and password.
2. In T3, open **Settings › Providers**, add **Hermes Agent**, and fill in the API URL and key.
   The dashboard URL, username and password are optional; they unlock the Hermes settings below.
   **Agent name** names the sidebar section and the composer's Hermes chip.
3. Turn the provider on. The keys and password are stored as secrets on the T3 host and never
   sent back to a client.

## Start and find sessions

Hermes sessions live in their own section of the sidebar, named after the agent, above **Other
Agents**, and never inside a project. It lists the T3 threads you started with Hermes together
with the sessions Hermes holds from anywhere else, newest first, from the last three days.
**Load more** goes further back and **Show less** returns to the last three days. Pin a session
to keep it at the top whatever its age.

- Click **+** on the section header to start a new session, or pick **Hermes Agent** in any new
  thread's model picker. Either way the thread moves into the Hermes section.
- Click a session Hermes started elsewhere to continue it in T3 with its history. Its next turn
  goes on in the same Hermes session.
- Cmd/Ctrl-click or Shift-click selects several. Right-click for **Continue**, **Pin**,
  **Archive**, **Delete** and **Copy session ID**; they apply to the whole selection.

**Archive** archives the session in Hermes too. Archived sessions are listed in **Settings ›
Archived**, where **Unarchive** brings them back. **Delete** removes the session from Hermes and
its T3 thread after one confirmation. A session that is still running can't be archived or
deleted until it stops.

A session from elsewhere shows in full: its messages, reasoning, and every tool call with its
result, as a turn run from T3 would. Clicking it again brings in whatever Hermes added since, such
as a later run or a reply sent from a chat platform. For a cron job's session, the report the job
delivered (to Discord, for example) also appears at the end, marked with where it went. Nothing is
sent anywhere by this; the chat platform keeps showing exactly what it did.

## Session details

The thread details card (`mod+shift+b`) reads a Hermes thread's details from Hermes, whether or
not the thread is running: where the session came from, its message, tool and API call counts,
token totals, cost, and when it was last active or ended. **Machine** is the computer Hermes runs
on. Context is estimated from the stored messages and marked **Estimated**; it leaves out
Hermes's system prompt and tool definitions, so the real use is higher. The window size is shown
only when the session uses the model Hermes is configured with. **Connectors** lists the MCP
servers in Hermes's config as Configured or Disabled; Hermes doesn't report whether they
connected.

## Models

With Hermes selected, the composer shows the usual model chip, labelled with the agent's name and
the picked model, or **Default** while Hermes's own model is used. Open it and choose the Hermes
tab: **Default** sits at the top, named after the model Hermes itself is configured with (for
example "Default · GPT-6.1-Sol"), and below it every signed-in Hermes provider has its own group.
Click a provider (or press Enter on it) to expand it; opening one closes the others. The group
holding the current model opens on its own. Searching looks through every provider at once, and
starred models stay at the top of their group. Reasoning and fast-mode traits appear for the picked
model, and for Default when Hermes reports what its configured model supports. The model you pick is
sent with every turn, so you can change it at any time. It applies only to that turn: it never
changes Hermes's config, so its chat platforms, cron jobs and CLI keep using Hermes's default.

Groups and models carry the names their vendors use: **Codex** with **GPT-6.1-Sol**, **Grok**
with **Grok 4.20 Reasoning**, **OpenRouter**, **Kilo**. Hermes can list more models than T3's own
Codex provider, because it lists everything your ChatGPT account can use, including models OpenAI
keeps out of the Codex picker. To see those in the Codex provider too, see
[hidden Codex models](fork-behavior.md#codex-can-show-hidden-models).

Hermes lists some account-only models, such as **GPT-6-Astra**, only while its own Codex sign-in
is fresh. When T3's Codex provider is signed in to the same ChatGPT account, the Hermes **Codex**
group also lists every model T3's Codex sees, so those models stay offered and the list follows
your account as it changes.

**Settings › Providers › Hermes Agent › Models** groups the models by Hermes provider. Expand a
provider to hide single models, or turn off its switch to hide the whole provider. Hiding only
changes what T3 offers; Hermes, its chat platforms and its other clients still see every
provider.

Some providers are never offered through Hermes because their terms don't allow their models to
be used from another app: Anthropic always, and Google when signed in through Gemini CLI or
Antigravity rather than an API key. They are listed under **Unavailable** in the Models section.
Kilo's gateway shows only its free models, which need no key.

## Hermes settings

With the dashboard filled in, the Hermes Agent card in **Settings › Providers** also shows:

- **Hermes config**: every Hermes setting, by category, with search. This is Hermes's global
  config, so changes also apply to its chat platforms, cron jobs and CLI.
- **Hermes keys**: set, replace or remove Hermes's environment keys. Values are write-only: T3
  only shows whether a key is set.
- **Custom endpoints**: add an OpenAI-compatible endpoint, make one the default, or remove it.

## Limits

- Attachments aren't sent; the message names them instead.
- T3's own text jobs, such as thread titles and commit messages, don't use Hermes, so they don't
  fill Hermes's session history.
- Not available in the mobile app yet.
