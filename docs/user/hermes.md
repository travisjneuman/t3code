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
   **Agent name** changes the sidebar section's label.
3. Turn the provider on. The keys and password are stored as secrets on the T3 host and never
   sent back to a client.

## Start and find sessions

Hermes sessions live in their own **Hermes Agent** section of the sidebar, above **Other
Agents**, and never inside a project. It lists the T3 threads you started with Hermes together
with the sessions Hermes holds from anywhere else, newest first, from the last three days.
**Load more** goes further back. Pin a session to keep it at the top whatever its age.

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

## Models

The model picker lists **Hermes default**, which uses whatever model Hermes is configured with,
plus every model of each provider you are signed in to in Hermes. The model you pick is sent with
every turn, so you can change it at any time, and it never changes Hermes's own default.

Some providers are never offered through Hermes because their terms don't allow their models to
be used from another app: Anthropic always, and Google when signed in through Gemini CLI or
Antigravity rather than an API key. Kilo's gateway shows only its free models, which need no key.

## Hermes settings

With the dashboard filled in, the Hermes Agent card in **Settings › Providers** also shows:

- **Hermes providers**: a switch per provider to hide it from the model picker.
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
