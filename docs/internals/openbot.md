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
opening an empty conversation creates one: the server leaves it out, and the client's fallback for
threads OpenBot no longer lists skips T3 threads with no items.

T3 starts neither new chats nor side threads. Local scripts posts only to the main conversation and
has no route that starts a side thread, and a new chat would have to clear the agent's context
(`context/clear`) in the conversation OpenBot keeps running. So every way in lands on an agent's
main conversation: the section's + opens the Chief of Staff's (`defaultOpenBotAgent`), the composer's
agent picker opens the picked agent's, and a new thread on OpenBot sends its first message there
(`sendOpenBotDraft`) instead of creating a thread of its own. Compare agents and scheduled tasks
create a thread per run, so they leave OpenBot out (`withoutOpenBot`).

An empty thread is treated as no conversation, never archived: the list leaves empty conversations
out, and a leftover thread from the retired New chat that never ran binds nothing, so the section
binds the conversation's own import (`openbot:<instance>:<conversation>`).

OpenBot's Team API (`agent-tasks-v1`: `/v1/agent-tasks/start` and friends, on a loopback port that
changes with every start, found through `/v1/compatibility`) can start side threads, but it takes a
team member's session, not the Local scripts token. T3 doesn't use it, because no member session can
be had locally in a packaged OpenBot (0.58.0): account members sign in at api.openbot.run, the host
redeems their tickets there, and members connect over WebRTC signalled through it. Password members
need local invites, which only a development host makes. Revisit if OpenBot's Local scripts gain
task routes.

## Known gaps

- Messages sent from OpenBot's own app during a T3 turn can land in that turn.
- The OpenBot section reuses `importedMessageEvents` from the Other Agents add-on, so `openbot`
  depends on `other-agents`.
