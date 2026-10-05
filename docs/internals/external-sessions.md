# External sessions (fork add-on)

The sidebar's "Other Agents" section lists sessions from agents running outside T3, such as Claude
Code, Codex, Grok, Pi and Antigravity, in a CLI, desktop app or IDE extension. Opening one shows the
session live, laid out like a T3 thread. An idle Claude, Codex, Grok or Pi session can be continued
in T3, which binds an ordinary thread to that same session.

## Decisions

- **Read the providers' own session stores; never write them.** Each agent already persists its
  sessions on disk (`~/.claude/projects`, `~/.codex/sessions`, `~/.grok/sessions`,
  `~/.pi/agent/sessions`, `~/.gemini/antigravity-cli`). One adapter per store lives in
  [`apps/server/src/external-sessions/`](../../apps/server/src/external-sessions). Watching a
  session writes nothing to T3's database; only an explicit continue, and the sync of a continued
  thread, do.
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
- **Continued threads sync both ways.** T3's turns land in the native transcript because the
  provider resumes the session in place, so the other app sees them when it reloads or resumes.
  For the other direction,
  [`externalSessionSync.ts`](../../apps/server/src/external-sessions/externalSessionSync.ts) follows
  each continued thread's transcript for the server's lifetime and copies what the other app
  appends into the thread:
  - **Attribution is by time, not markers.** No store marks every line with its writer, so an entry
    is T3's when it falls inside a T3 run or provider turn window (a few seconds of slack each
    side), or, for Codex, when its turn id is one of T3's provider turns. Everything else came from
    the other app. Users alternate between apps, so the windows rarely overlap the other app's
    work; when they do, that work is taken as T3's and not copied.
  - **Passes wait for T3.** While the thread has an active run, a pass only retries later. It never
    reads T3's own output mid-turn, and a cursor never moves past lines it could not attribute.
  - **Copied messages sort after the run they followed.** Runless items normally sit in the band
    before every run. The sync allocates each item's position in the band of the latest run that
    started before it, before writing the event. The sink's own allocation keeps an existing
    position, so no upstream change is needed. Ids derive from the line's byte offset, so a crash
    between write and cursor save re-upserts the same items.
  - **A stale T3 process is let go.** After copying, the thread's idle provider sessions are
    detached through `provider-session.detach`, so the next T3 turn resumes the session from disk.
    Claude also gets its conversation head moved to the newest main-chain entry. Detach is skipped
    while the provider thread has pending background work.
  - **T3 does not release its session after every turn.** An idle T3 process writes nothing, the
    detach above covers the staleness, and releasing after each turn would cost a respawn on every
    turn.
  - **The cursor lives outside the database.** `<state dir>/external-sessions-sync.json` holds the
    byte offset per thread, always at a line start (for Grok, at the start of a reply that may
    still grow), plus Codex's open turn id. Threads continued before the sync existed catch up from
    the size continue recorded (Claude, Codex) or start at the current end (Grok, Pi).
  - **Watching costs nothing while idle.** One non-recursive watch per transcript directory, a
    600 ms debounce, a size check before any read, and reads of appended bytes only (at most 8 MB a
    pass). A 30 second size check covers a missed watch event.
  - **"Running elsewhere" is a warning, not a lock.** `externalSessions.subscribeRunningElsewhere`
    sends the set of continued threads whose transcript gained an entry from the other app in the
    last minute, or that hold an open Codex turn the other app started. The whole set goes out on
    subscribe and again only when it changes. The web composer shows a warning banner on those
    threads through `RunningElsewhereBanner.tsx`. Sending stays allowed. Only `import:` threads
    open the stream.
- **Watch the list only while someone looks.** The registry is an `RcRef`. The first list or session
  subscriber starts the file watchers and the initial discovery, which covers the last 3 days. The
  watchers stop 30 seconds after the last subscriber leaves. Bursts of writes, such as a streamed
  reply, are batched into one re-read about every 600 ms.
- **Older sessions open on demand.** A session subscribe for a key the registry lacks, such as an
  older [session search](./session-search.md) result, walks that one store once over search's
  90-day window
  ([`sessionHistory.ts`](../../apps/server/src/external-sessions/sessionHistory.ts)) and keeps
  only files named after the session id. The match is registered like a discovered session, so
  the existing watchers keep it current and it can be continued. The list still shows 3 days.
- **The transcript stream follows bytes, not files.** A session stream opens with the newest
  messages from at most 8 MB of the transcript's tail, then reads only the bytes appended after
  that. Messages are upserted by id, so a streamed reply grows in place.
- **T3's own sessions are excluded.** The first two items below are `ownedSessionIds`, which
  session search reads too. That covers:
  - the native id of every provider thread on a live T3 thread, which covers threads T3 started
    and continued sessions; the exclusion is refreshed right after a continue, so the session
    leaves the list at once
  - ids in any provider runtime resume cursor, which covers imported sessions
  - cwds under the T3 home or worktrees (scratch threads)
  - Codex rollouts whose originator is T3
  - Codex subagent rollouts, which belong to their parent
- **Archive is T3 state, plus Codex's own archive.** Archived keys live in
  `<state dir>/external-sessions-archive.json` (not SQLite, so upstream keeps its migration
  numbering), and the list leaves them out. For Codex, archive and unarchive also call the
  app-server's `thread/archive` / `thread/unarchive` through the enabled, unmanaged Codex
  instance whose shared home is `~/.codex`, the store the list reads. A Codex failure leaves the
  T3 archive in place and comes back as a warning. Other agents have no archive of their own, so
  theirs is T3-only. Each entry keeps its title, cwd and driver because Codex moves the rollout out
  of `sessions/`, where the list no longer finds it.
- **Claude desktop's archive is mirrored read-only.**
  [`claudeDesktopArchive.ts`](../../apps/server/src/external-sessions/claudeDesktopArchive.ts)
  keeps only `cliSessionId` and `isArchived` from the Claude app's
  `claude-code-sessions/*/*/local_*.json` records; the rest holds account and bridge ids. Those
  sessions leave the list and reach Settings › Archived with `archivedIn: "claudeDesktop"` and no
  Unarchive, because T3 never writes Claude's files. The scan rides the list's republish (at most
  every 10 seconds, only while the list is watched, re-reading only files whose mtime changed) and
  covers only sessions the registry knows, since their titles come from the transcripts.
- **Stay mergeable with upstream.** All logic lives in the add-on folders: server
  `external-sessions/`, web `apps/web/src/external-sessions/` plus one route, and contracts
  `externalSessions.ts`. The contract exports the RPC tuple (`ExternalSessionsRpcs`), the scope
  map, and the subscription method type, so a new RPC never touches an upstream file. Upstream
  files only gain one-line hooks marked "Fork add-on":
  - the contracts index and RPC group (one spread)
  - RPC authorization (one spread)
  - the client subscription tag union
  - the server runtime layer
  - `ws.ts`
  - the sidebar mount
  - the Settings › Archived route's panel import
  - the composer banner stack in `ChatView`

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
- Synced messages are runless. Reverting or rolling back a T3 run does not hide them, and a fork
  copies only run items. A rewind in the other app shows up as more messages after the old ones.
  Message text is clipped at 20,000 characters, as in the live view.
- If the other app and T3 write the same session at the same time, the other app's entries inside
  T3's window are not copied, and a detach can race a turn the user sends right then.
- A continued thread is "native" so its own provider resumes without replaying history, but
  upstream reads runless items as handoff context only for `v1_import` threads. The
  `carriesImportedHistory` hook in `Orchestrator.ts` also counts `import:` threads, so a switch to
  another provider carries the imported and synced history; the first same-provider turn still
  skips it, because `shouldPrepareLegacyImportHandoff` keeps requiring `v1_import`.
- Turns run by another provider never reach the original session. When the thread switches back,
  the usual handoff delta goes into the resumed session, so the other app sees it from then on.
- Mobile does not render this section or the running warning yet. The RPCs are
  environment-scoped, so they can be added later from the same contracts.
