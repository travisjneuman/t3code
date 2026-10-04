# External sessions (fork add-on)

The sidebar's "Other agents" section lists sessions from agents running outside T3, such as Claude
Code, Codex, Grok, Pi and Antigravity, in a CLI, desktop app or IDE extension. Opening one shows a
read-only, live transcript.

## Decisions

- **Read the providers' own session stores; never write them.** Each agent already persists its
  sessions on disk (`~/.claude/projects`, `~/.codex/sessions`, `~/.grok/sessions`,
  `~/.pi/agent/sessions`, `~/.gemini/antigravity-cli`). One adapter per store lives in
  [`apps/server/src/external-sessions/`](../../apps/server/src/external-sessions). Nothing is
  imported into T3's database, so these sessions are not threads and cannot be continued from T3.
  Importing a session is the existing project import flow.
- **Watch only while someone looks.** The registry is an `RcRef`. The first list or session
  subscriber starts the file watchers and the initial discovery, which covers the last 3 days. The
  watchers stop 30 seconds after the last subscriber leaves. Bursts of writes, such as a streamed
  reply, are batched into one re-read about every 600 ms.
- **The transcript stream follows bytes, not files.** A session stream opens with the newest
  messages from at most 8 MB of the transcript's tail, then reads only the bytes appended after
  that. Messages are upserted by id, so a streamed reply grows in place.
- **T3's own sessions are excluded.** That covers ids in any provider runtime resume cursor, cwds
  under the T3 home or worktrees (scratch threads), Codex rollouts whose originator is T3, and
  Codex subagent rollouts, which belong to their parent.
- **Stay mergeable with upstream.** All logic lives in the add-on folders: server
  `external-sessions/`, web `apps/web/src/external-sessions/` plus one route, and contracts
  `externalSessions.ts`. Upstream files only gain one-line hooks marked "Fork add-on": the
  contracts index and RPC group, RPC authorization, the client subscription tag union, the server
  runtime layer, `ws.ts`, and the sidebar mount.

## Constraints

- Store formats are private to each agent and can change. An adapter skips any line it can't parse
  instead of failing the stream.
- The Antigravity CLI keeps no readable transcript, so its sessions are listed without messages.
- Secrets never cross the wire. Adapters send only titles, cwd, model, user and assistant text,
  and a one-line summary of each tool call. They never send reasoning, system prompts, or account
  fields such as Claude's bridge-session records. They never read the `.key` files in the Claude
  registry or Codex `auth.json`.
- Mobile does not render this section yet. The RPCs are environment-scoped, so it can be added
  later from the same contracts.
