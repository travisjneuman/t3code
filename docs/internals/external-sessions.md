# External sessions (fork add-on)

The sidebar's "Other agents" section lists sessions from agents running outside T3, such as Claude
Code, Codex, Grok, Pi and Antigravity, in a CLI, desktop app or IDE extension. Opening one shows the
session live, laid out like a T3 thread. An idle Claude, Codex, Grok or Pi session can be continued
in T3, which binds an ordinary thread to that same session.

## Decisions

- **Read the providers' own session stores; never write them.** Each agent already persists its
  sessions on disk (`~/.claude/projects`, `~/.codex/sessions`, `~/.grok/sessions`,
  `~/.pi/agent/sessions`, `~/.gemini/antigravity-cli`). One adapter per store lives in
  [`apps/server/src/external-sessions/`](../../apps/server/src/external-sessions). Watching a
  session writes nothing to T3's database; only an explicit continue does.
- **Render with the thread timeline, not a second transcript.** The view feeds the messages to
  the standard `MessagesTimeline` as runless timeline entries: user and assistant text become
  message entries, and each tool line becomes a work entry. The header and the docked
  composer-shaped block reuse the chat view's classes and `ComposerSurface`, so switching
  between a thread and a session keeps the same geometry; the block's send slot holds Continue. Markdown, width, folding, scrolling and theming therefore follow upstream
  changes for free. Actions that need a T3 run, such as fork, revert, diffs and citations, get
  no-ops, so they never render.
- **Continue binds the session in place; it never copies or moves it.** The thread's provider
  thread points at the native session with a strong ref, so the next turn resumes that session id
  in its own files and config home, and the user can return to the other app afterwards. The cwd
  is the project root, which is the session's own cwd. Per driver:
  - Claude resumes by session id under the instance's `CLAUDE_CONFIG_DIR`. The provider thread
    also gets a weak conversation head at the transcript's newest main-chain entry, because the
    adapter opens a session that has no T3 turns with `sessionId`, which Claude refuses for an id
    that already exists. The head makes it `resume` at that entry; the adapter clears the head
    after the first completed turn.
  - Codex resumes with `thread/resume`. A shadow home links `sessions/` back to the shared home,
    so new rollout lines land in the same file.
  - Grok resumes through ACP `session/load` under `GROK_HOME` (default `~/.grok`). The provider
    thread id and item identity match what the ACP adapter creates, so its turns update this
    thread.
  - Pi resumes with `switch_session` by session file path, which is Pi's native id; Pi always uses
    `~/.pi/agent`, so any enabled Pi instance can resume it.
- **Continued history is "native", not "v1_import".** With `v1_import`, the first turn would also
  hand the whole history over as a legacy context handoff, on top of a provider session that
  already holds it. If the native resume fails, the adapter's fresh-session fallback still sends
  these runless items in its summary handoff, so nothing is lost. The cost: a fork of a continued
  thread copies only items from T3 runs, while the native fork still carries the full session.
  The onboarding project import keeps `v1_import` and skips a continued thread as modified.
- **Continue is a single-session import, and only while the session is not running.** It writes
  the project (bootstrapped or reused), an active thread, its messages and the provider thread.
  For Claude and Codex it also writes the importer's runtime row and imported-transcript record.
  The thread id is `import:<instance>:<session>`, so a second continue, or a later project import,
  returns the same thread instead of duplicating it. Claude and Codex history comes from the
  importer's parser, Grok and Pi history from this add-on's own parsers (user and assistant text
  only). Two writers on one native session would interleave its transcript, so the server refuses
  while the session is running. Logic lives in
  [`continueExternalSession.ts`](../../apps/server/src/external-sessions/continueExternalSession.ts),
  which imports only exported pieces of upstream code.
- **Antigravity stays watch-only.** T3 runs Antigravity with a private per-instance `GEMINI_HOME`,
  which cannot see a CLI conversation in `~/.gemini`, and the CLI keeps no transcript for a context
  handoff. The view shows the `separate-store` reason. Continuing it needs an Antigravity option
  upstream to use the user's own store.
- **No two-way sync after continue.** Turns made in the other app after a continue show up in T3
  only when the provider resumes them on the next T3 turn; T3 does not copy them into the
  timeline. Copying them would need a per-line key that tells T3's own writes from the other
  app's, and no store offers one for every driver. A live T3 process also keeps its view of the
  session until it is released, so the user should send from one app at a time.
- **Watch only while someone looks.** The registry is an `RcRef`. The first list or session
  subscriber starts the file watchers and the initial discovery, which covers the last 3 days. The
  watchers stop 30 seconds after the last subscriber leaves. Bursts of writes, such as a streamed
  reply, are batched into one re-read about every 600 ms.
- **The transcript stream follows bytes, not files.** A session stream opens with the newest
  messages from at most 8 MB of the transcript's tail, then reads only the bytes appended after
  that. Messages are upserted by id, so a streamed reply grows in place.
- **T3's own sessions are excluded.** That covers:
  - the native id of every provider thread on a live T3 thread, which covers threads T3 started
    and continued sessions; the exclusion is refreshed right after a continue, so the session
    leaves the list at once
  - ids in any provider runtime resume cursor, which covers imported sessions
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
  session left open but quiet in another app reads as idle, so continue can't refuse it. The
  composer block asks the user to stop it there first.
- Continue reads the whole transcript, up to 64 MB. A larger one is refused instead of being
  truncated.
- Mobile does not render this section yet. The RPCs are environment-scoped, so it can be added
  later from the same contracts.
