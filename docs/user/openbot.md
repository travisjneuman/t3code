# OpenBot

_Fork add-on._ Chat with your OpenBot agents from T3 Code and follow every
conversation they hold. T3 reads OpenBot's own database and sends through OpenBot's **Local
scripts** API, so OpenBot keeps running as it is, with its schedules, side threads and its own app.

## Set it up

1. In OpenBot, turn on **Local scripts** for each agent you want to message from T3.
2. In T3, open **Settings › Providers**, add **OpenBot**, and turn it on. Add it on one server
   only, usually the desktop app you use every day.
3. If OpenBot runs on another machine, set **SSH host** to that machine, as you would type it after
   `ssh`. The T3 server must reach it with a key and no password prompt, and the machine needs
   node 22.13 or newer. T3 reads OpenBot's conversations and sends messages there, so OpenBot's
   Local scripts API never has to leave that machine. Leave it blank when OpenBot runs on the same
   machine as the T3 server.
4. Leave **OpenBot folder** blank to use OpenBot's default folder on OpenBot's machine
   (`~/Library/Application Support/OpenBot` on macOS, `%APPDATA%\OpenBot` on Windows,
   `~/.config/OpenBot` on Linux). Set it when OpenBot keeps its data somewhere else, for example a
   Docker install whose data folder is mounted at another path.

The provider shows **Authenticated** once it has read OpenBot's agents. OpenBot writes a new Local scripts
token each time it starts; T3 reads it on OpenBot's machine for every request and never copies it,
stores it or sends it to a client.

The **Usage** page shows the tokens and cost OpenBot records for each turn, by model.

## Find and open conversations

Each OpenBot provider has its own section in the sidebar, above **Other Agents**. It is titled with
the provider's name from **Settings › Providers**, or **OpenBot · <SSH host>** when OpenBot runs on
another machine and its name is left as "OpenBot". It lists each agent's main conversation as
**Name - Role**, newest first, with the role shortened to its initials (Chief Technology Officer is
CTO, Chief of Staff is CoS; hover a row for the full role). The agent's side threads are nested
under it like subagents. A side thread shows when it is running; click the count beside the agent
to show them all. Collapsed, the section still shows the conversations that are running.

- Click a conversation to open it in T3 with its history, tool calls and reasoning included. It
  opens in the Scratch project, since OpenBot works in its own folders. Clicking it again later
  brings in whatever OpenBot added since.
- Agents with Local scripts on are listed even before they have a conversation, so you can start
  one from the sidebar.
- Right-click for **Open**, **Copy conversation ID**, and, once opened, **Archive thread** and
  **Delete thread**. These act on the T3 thread only; the conversation stays in OpenBot. Opening
  it again brings back an archived thread.
- Right-click the section header to **Refresh**. The section also refreshes when T3 comes back to
  the front.

## Start a new chat

Click **+** beside the OpenBot section's title and pick an agent, or right-click an agent and choose
**New chat**. T3 opens a new thread and OpenBot starts a new chat with that agent, as its own
**New chat** button does: the agent no longer carries the earlier conversation in its context.
Pick a provider and model in the new thread's model picker before you send; the agent moves there
with your first message.

- Only agents with Local scripts on are offered. OpenBot refuses a new chat while the agent is
  working.
- OpenBot keeps one main conversation per agent, so the earlier chat is still there in OpenBot's app.
  In T3, its thread moves to **Settings › Archive**; unarchive it to see it in the section
  again.
- T3 can't start OpenBot side threads; OpenBot starts those itself.

## What you can send

T3 sends only to an agent's **main conversation**, and only when that agent has Local scripts on.
Side threads and agents without Local scripts show an eye icon: you can read them in T3 but not
message them.

- Messages are text only. Attachments are refused.
- The model picker lists the provider and model pairs OpenBot already uses for an agent or a
  running session. Picking one moves the agent there from your next message, in OpenBot too and for
  all of its conversations, since OpenBot sets the model per agent. OpenBot refuses a model it has
  not listed, and a change of provider while the agent is working; T3 then shows OpenBot's reason
  and does not send. Pick the agent itself in the sidebar, not the picker.
- A turn can't be stopped or steered from T3, because OpenBot offers no way to do that from
  outside. Stop it in OpenBot if you need to.
- A conversation OpenBot is working on outside T3 shows **Running in OpenBot**. That state comes
  from the last refresh, so it can lag behind OpenBot.
- If you message the same agent from OpenBot's app while a T3 turn is running, those messages may
  show up in T3's turn.
