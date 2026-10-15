# Session insights

Fork add-on. `sessionInsights.get` answers the thread details card's [session details](../user/session-details.md):
a context breakdown, the MCP servers of a thread's provider session, the server's machine name, and
for agents that keep one, the agent's own session record. Code:
[`apps/server/src/sessionInsights/`](../../apps/server/src/sessionInsights/), contracts in
[`sessionInsights.ts`](../../packages/contracts/src/sessionInsights.ts).
`externalSessions.insights` answers the same card for an Other Agents session.

## Adapter capability

Adapters opt in through the optional `sessionInsights` member of
`ProviderAdapterV2SessionRuntime`, with optional `contextBreakdown` and `mcpServers` methods. A
provider implements only what its protocol exposes:

- Claude: both, from SDK `getContextUsage` (categories and auto-compact threshold) and
  `mcpServerStatus`.
- Codex: a totals-only breakdown from `thread/tokenUsage/updated`, skills from `skills/list`, and
  MCP servers.
- The shared ACP adapter (Grok, Antigravity, registry agents): totals from `usage_update`, skills
  from `available_commands_update`, and the MCP servers T3 hands the session as `configured`.
- Pi (`get_session_stats`) and Muse (`session/contextUsage`): totals only. Cursor: the MCP servers
  in the config T3 sends. Both OpenCode adapters: MCP servers.

Shared mapping helpers, including the totals-only breakdown, are in
`@t3tools/provider-core/server/sessionInsights`.

## Hermes

Hermes keeps its own session store, so `get` reads a Hermes thread from Hermes over HTTP before it
looks for a live provider session
([`provider-hermes/src/server/insights.ts`](../../packages/provider-hermes/src/server/insights.ts)).
`hermesSessions.insights` makes the same read for a session T3 has not opened, so the sidebar's
Details item never imports it. The instance's settings are decoded on the server, as the Hermes
adapter does; credentials never reach the reply or the logs. Five read-only GETs run together, each
allowed to fail alone: the session record, its messages, and the dashboard's model info, MCP
servers and status. The whole read has a 30-second timeout, since a long session's messages come
in pages. When Hermes answers nothing, the usual live-session path runs.

- The session record (`SessionRecord`) is Hermes's own count of messages, tool and API calls,
  tokens and cost. `costEstimated` marks Hermes's estimated cost, used only when it reports no
  actual cost. Turns and their duration are counted from the stored messages; the version is the
  running Hermes's, so only a session that has not ended carries it. A session quiet for an hour
  reads as idle.
- Hermes reports no token usage for its context, so the breakdown is counted from the stored
  messages at four characters a token, by role, and marked `estimated` with a `note`. The system
  prompt and tool schemas are not stored, so the estimate is low. The window size comes from the
  dashboard's `effective_context_length`, and only when its model is the session's model; Hermes
  exposes no other model's window (`/api/model/options` carries none), so otherwise the breakdown
  has no limit or free space.
- MCP servers come from the dashboard's configuration, not a connection, so an enabled server is
  `configured`. Only names, the enabled flag and tool counts are read, never commands, URLs or
  environment values.
- Hermes edits leave no T3 turn diff, so `outputs` lists the files its `write_file` and `patch`
  calls changed, from the stored tool-call arguments. Failed calls are left out; edits made through
  `terminal` commands are not seen.
- `host` is the API URL's host rather than the T3 server's, since the agent runs where Hermes
  runs, and the card leaves out the folder: a Hermes thread's Scratch folder is not where the
  agent works.

## Other Agents

`externalSessions.insights` (read scope) returns the server's machine name, the files a session's
edit and write tools changed, and what the agent's own store records: a `SessionRecord`, a context
breakdown and MCP servers. Each source may implement `readInsights`
([`ExternalSessionSource.ts`](../../apps/server/src/external-sessions/ExternalSessionSource.ts));
the source readers and the outputs read run side by side, each with an 8-second timeout, and a
failure comes back empty.

- Transcripts are read forward from a saved byte offset (`scanForward`), so a repeat read parses
  only appended lines, and the whole session is covered rather than a tail. `truncated` is set
  only when a read times out. Small JSON files are re-read when their mtime moves.
- Outputs: each agent records edits its own way. Claude's tool results carry the patch (its
  subagents' `agent-*.jsonl` are merged in), Codex's `apply_patch` envelopes name each file, Pi's
  `edit` calls carry each replacement, and Grok's ACP updates carry old and new text. A later
  record of the same call replaces an earlier one. Other drivers return `null`, which hides
  Outputs.
- Claude's window is the CLI's: `autoCompactWindow` (env, managed, project, then user settings)
  capped at the model's catalog window, with the threshold `min(max output, 20k) + 13k` below it
  ([`claudeContextWindow.ts`](../../apps/server/src/external-sessions/claudeContextWindow.ts)).
  Used tokens are the latest request's input and cache tokens; output joins the next request.
- Claude's breakdown comes from the transcript's start-of-session attachments (memory files, skill
  listing, agent and deferred-tool deltas, MCP instructions, compact boundaries), indexed once per
  transcript ([`claudeSessionIndex.ts`](../../apps/server/src/external-sessions/claudeSessionIndex.ts)).
  The total is measured; the parts are counted from their text and marked `estimated`, and the
  remainder is "System prompt and tools". Claude Desktop's `local_<id>.json` is read by allowlist:
  model, effort, permission mode, times, versions, and only whether bridge sessions exist.
- Codex, Grok, Pi and Antigravity fill the record from their rollout, `usage.json` and
  `signals.json`, session entries, and conversation databases. A store that records no cost
  returns `modelUsage`, which `insights` prices against the Usage page's rate table and marks
  `costEstimated`. Codex MCP servers are the `config.toml` table names, `configured`; nothing else
  in that file is read.

## Constraints

- A read never starts or resumes a session. It asks only a live provider session; otherwise it
  answers with the last report it read, marked not live with its capture time. Each live report is
  saved to `session_insights_reports` (newest 500), so a stopped thread keeps its card across a
  server restart. That table belongs to the fork's own migration ledger, `fork_sql_migrations`
  ([`ForkMigrations.ts`](../../apps/server/src/persistence/ForkMigrations.ts)): upstream's migrator
  skips every id at or below the highest it has recorded, and the fork shares `~/.t3` with
  official T3 Code, so a fork id in upstream's ledger would hide a future upstream migration.
  Hermes reports are read from Hermes each time and always count as live.
- Each part has its own 10-second timeout, and a failed or slow part comes back empty without
  hiding the other.
- MCP status rows can carry a server's configuration, headers included, so they stay out of
  provider logs: Claude's protocol log records only the count, and OpenCode logs nothing.
- Estimates are labeled as estimates. A provider that reports no categories shows token totals,
  never categories made up to fill the bar.
- The web client queries only while the card is open at full density, and refetches when a turn
  settles or the session status changes. An Other Agents card refetches when a running session
  stops or an idle one's update time moves, and while one runs, on its next change at least 30
  seconds after the last refetch. Nothing polls or runs a timer.
