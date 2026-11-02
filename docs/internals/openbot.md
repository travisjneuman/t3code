# OpenBot provider

_Fork add-on (`openbot`)._ How T3 talks to OpenBot, and what a maintainer would get wrong without
reading every file. Usage: [user guide](../user/openbot.md).

## Two channels, one record

`openbot.db` in the OpenBot folder is the conversation of record. OpenBot's Local scripts API
(`automation/url` and `automation/token`) can post a message and report its delivery, but cannot
read history. So the driver ([`packages/provider-openbot`](../../packages/provider-openbot)) sends
through the API and reads everything else from the database, opened read-only. OpenBot rewrites
the URL and token on each start, so both are read per request; a 401 rereads them once.

## Another machine over SSH

The API listens on loopback only, on a port that changes with every start, and the history is a
local SQLite file, so neither can be reached from another machine directly. With **SSH host** set,
[`host.ts`](../../packages/provider-openbot/src/server/host.ts) pipes a small script to `node` on
that machine, which runs the same queries or API call there and prints the result as JSON. The
token is read and used on OpenBot's machine and never crosses the wire. That script repeats the
local code path in plain JavaScript, so the two must change together. Calls share one SSH
connection (`ControlMaster`, except on Windows), since a running turn polls every two seconds.

## Why Other Agents never saw OpenBot

Other Agents scans the T3 server user's home folder for each CLI's transcripts. OpenBot runs its
agent CLIs with a home of its own (in the Docker install, `/data`, mounted from OpenBot's data
folder), and its conversations live in `openbot.db`, not in CLI transcripts. That is why OpenBot is a
provider with its own section rather than another Other Agents source.

## Binding

The model slug is an OpenBot `provider/model` pair; the agent comes from the thread's binding. A T3
thread on OpenBot binds to the agent's main conversation (`openbot-thread-<agentId>`), the only one
Local scripts posts to. Side threads, and agents without Local scripts, are listed but watch-only.
Opening a conversation from the section creates or reuses one Scratch thread for it
(`openbot:<instance>:<conversation>`) and imports its rows with keys taken from OpenBot's message
ids, so a re-sync writes only new rows. Rows that fall inside the window of a T3 turn (30 s either
side) are skipped, because the adapter already wrote them as turn items.

Before sending, the adapter moves the agent to the picked pair and reasoning effort through
`POST /v1/agents/:id/settings`, which accepts only `provider`, `model`, `reasoningEffort` and
`providerAccountId` and refuses any other key, so access, computer use and notifications stay
OpenBot-only. OpenBot learns each model's efforts from its provider CLI and keeps them in memory, so
the picker offers all five (Haiku only medium), defaults to the effort most agents on that model use,
and shows OpenBot's 409 when a model lacks one. Effort is sent only when picked and different from
the agent's.

The adapter sends only the typed text, never T3's agent instructions: OpenBot's agents delegate to
each other under OpenBot's own rules, and prepended rules would land in OpenBot's conversation. So
the composer hides the Agents preset and permissions controls for OpenBot, and the section lists an
agent only once OpenBot holds messages or side threads for it. A T3 thread doesn't count, since
opening an empty conversation creates one. New chats still reach every agent.

A new chat binds a fresh T3 thread (`openbot:<instance>:new-chat:<id>`) to the agent's
conversation. Until its first run it is pending: the section's binding skips it, and `setAgent`
can rebind it to another agent by rewriting its provider thread's native id. The model picker
can't carry the agent, because a model option would show up as its effort. The adapter clears the
agent's context (`POST /v1/agents/:id/context/clear`, which keeps the old messages in the same
OpenBot thread) on the first send rather than at creation, so an abandoned new chat costs nothing.
So one conversation can have several T3 threads: each new chat's provider thread id is derived from
`<conversation>#<thread>` so it doesn't take over the earlier chat's, the section follows the newest
started unarchived one, and a sync imports only rows from after the thread was created. Once a new
chat has a run, the next list archives the conversation's other threads whose last update came
before that run; an unarchive bumps the update time, so the thread stays. Local scripts can't
start OpenBot side threads, so a new chat is the only "new session" T3 can offer.

## Known gaps

- Messages sent from OpenBot's own app during a T3 turn can land in that turn.
- The OpenBot section reuses `importedMessageEvents` from the Other Agents add-on, so `openbot`
  depends on `other-agents`.
