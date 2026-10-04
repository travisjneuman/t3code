# External sessions (fork add-on)

The sidebar's "Other agents" section lists sessions from agents running outside T3, such as Claude
Code, Codex, Grok, Pi and Antigravity, in a CLI, desktop app or IDE extension. Opening one shows the
session live, laid out like a T3 thread. An idle Claude or Codex session can be continued in T3,
which turns it into an ordinary thread.

## Decisions

- **Read the providers' own session stores; never write them.** Each agent already persists its
  sessions on disk (`~/.claude/projects`, `~/.codex/sessions`, `~/.grok/sessions`,
  `~/.pi/agent/sessions`, `~/.gemini/antigravity-cli`). One adapter per store lives in
  [`apps/server/src/external-sessions/`](../../apps/server/src/external-sessions). Watching a
  session writes nothing to T3's database; only an explicit continue does.
- **Render with the thread timeline, not a second transcript.** The view feeds the messages to
  the standard `MessagesTimeline` as runless timeline entries: user and assistant text become
  message entries, and each tool line becomes a work entry. The header and the docked bar reuse
  the chat view's classes and `ComposerSurface`, and the bar stands in for the composer the way
  the subagent bar does. Markdown, width, folding, scrolling and theming therefore follow upstream
  changes for free. Actions that need a T3 run, such as fork, revert, diffs and citations, get
  no-ops, so they never render.
- **Continue is a single-session import, and only while the session is not running.** It writes
  the records that the project import (`AgentSessionImporter`) writes for one session: the
  project (bootstrapped or reused), an active thread with `historyOrigin: "v1_import"`, its
  messages, a provider thread that points at the native session, and the runtime row with the
  importer's resume cursor. The thread id is `import:<instance>:<session>`, so a second continue,
  or a later project import, returns the same thread instead of duplicating it. The provider
  resumes its own session on the next turn. Two writers on one native session would interleave
  its transcript, so the server refuses while the session is running, and the UI asks the user
  to stop it in the other app first. Logic lives in
  [`continueExternalSession.ts`](../../apps/server/src/external-sessions/continueExternalSession.ts).
  It only imports exported pieces of the importer, because a refactor of upstream code would not
  merge.
- **Only drivers T3 can resume.** Claude and Codex continue. Grok, Pi and Antigravity stay
  watch-only, and the bar shows the reason. The transcript must also sit under the home of an
  enabled provider instance, since that instance is the one that resumes it.
- **Watch only while someone looks.** The registry is an `RcRef`. The first list or session
  subscriber starts the file watchers and the initial discovery, which covers the last 3 days. The
  watchers stop 30 seconds after the last subscriber leaves. Bursts of writes, such as a streamed
  reply, are batched into one re-read about every 600 ms.
- **The transcript stream follows bytes, not files.** A session stream opens with the newest
  messages from at most 8 MB of the transcript's tail, then reads only the bytes appended after
  that. Messages are upserted by id, so a streamed reply grows in place.
- **T3's own sessions are excluded.** That covers:
  - ids in any provider runtime resume cursor, which includes continued sessions; the exclusion
    is refreshed right after a continue, so the session leaves the list at once
  - cwds under the T3 home or worktrees (scratch threads)
  - Codex rollouts whose originator is T3
  - Codex subagent rollouts, which belong to their parent
- **Stay mergeable with upstream.** All logic lives in the add-on folders: server
  `external-sessions/`, web `apps/web/src/external-sessions/` plus one route, and contracts
  `externalSessions.ts`. Upstream files only gain one-line hooks marked "Fork add-on":
  - the contracts index and RPC group
  - RPC authorization
  - the client subscription tag union
  - the server runtime layer
  - `ws.ts`
  - the sidebar mount

## Constraints

- Store formats are private to each agent and can change. An adapter skips any line it can't parse
  instead of failing the stream.
- The Antigravity CLI keeps no readable transcript, so its sessions are listed without messages.
- Secrets never cross the wire:
  - Adapters send only titles, cwd, model, user and assistant text, and a one-line summary of
    each tool call.
  - They never send reasoning, system prompts, or account fields such as Claude's bridge-session
    records.
  - They never read the `.key` files in the Claude registry or Codex `auth.json`.
- "Running" means the agent reports a turn in progress (Claude's session registry, Codex
  `task_started` without a matching completion) or the transcript changed in the last minute. A
  session left open but quiet in another app reads as idle, so continue can't refuse it. The bar
  asks the user to stop it there first.
- Continue reads the whole transcript, up to 64 MB. A larger one is refused instead of being
  truncated.
- Mobile does not render this section yet. The RPCs are environment-scoped, so it can be added
  later from the same contracts.
