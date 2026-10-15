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
provider implements only what its protocol exposes: Claude both (SDK `getContextUsage` and
`mcpServerStatus`), Codex and both OpenCode adapters only `mcpServers`. Shared mapping helpers are in
`@t3tools/provider-core/server/sessionInsights`.

## Hermes

Hermes keeps its own session store, so `get` reads a Hermes thread from Hermes over HTTP before it
looks for a live provider session
([`provider-hermes/src/server/insights.ts`](../../packages/provider-hermes/src/server/insights.ts)).
The instance's settings are decoded on the server, as the Hermes adapter does; credentials never
reach the reply or the logs. Four read-only GETs run together, each allowed to fail alone: the
session record, its messages, and the dashboard's model info and MCP servers. The whole read has a
30-second timeout, since a long session's messages come in pages. When Hermes answers nothing, the
usual live-session path runs.

- The session record (`SessionRecord`) is Hermes's own count of messages, tool and API calls,
  tokens and cost. `costEstimated` marks Hermes's estimated cost, used only when it reports no
  actual cost.
- Hermes reports no token usage for its context, so the breakdown is counted from the stored
  messages at four characters a token, by role, and marked `estimated` with a `note`. The system
  prompt and tool schemas are not stored, so the estimate is low. The window size comes from the
  dashboard's `effective_context_length`, and only when its model is the session's model;
  otherwise the breakdown has no limit or free space.
- MCP servers come from the dashboard's configuration, not a connection, so an enabled server is
  `configured`. Only names, the enabled flag and tool counts are read, never commands, URLs or
  environment values.
- `host` is the API URL's host rather than the T3 server's, since the agent runs where Hermes
  runs, and the card leaves out the folder: a Hermes thread's Scratch folder is not where the
  agent works.

## Other Agents

`externalSessions.insights` (read scope) returns the server's machine name and the files a session's
edit and write tools changed
([`sessionOutputs.ts`](../../apps/server/src/external-sessions/sessionOutputs.ts)). It reads one
transcript tail with the session snapshot's byte limit and marks the result `truncated` when the
tail did not reach the start. Each agent records edits its own way: Claude's tool results carry the
patch, Codex's `apply_patch` envelopes name each file, Pi's `edit` calls carry each replacement,
and Grok's ACP updates carry old and new text. A later record of the same call replaces an earlier
one. Pi's `write` has no line counts. Other drivers return `null`, which hides Outputs. The rest of
the card comes from the session summary the view already has.

## Constraints

- A read never starts or resumes a session. It asks only a live provider session; otherwise it
  answers with the last report it read, marked not live with its capture time. Those reports are
  kept in server memory (200 provider threads), so a server restart forgets them. Hermes reports
  are read from Hermes each time and always count as live.
- Each part has its own 10-second timeout, and a failed or slow part comes back empty without
  hiding the other.
- MCP status rows can carry a server's configuration, headers included, so they stay out of
  provider logs: Claude's protocol log records only the count, and OpenCode logs nothing.
- Estimates are labeled as estimates. A provider that reports no categories shows token totals,
  never categories made up to fill the bar.
- The web client queries only while the card is open at full density, and refetches when a turn
  settles or the session status changes. An Other Agents card refetches when a running session
  stops or an idle one's update time moves, never while it streams. Neither polls.
