# Session insights

Fork add-on. `sessionInsights.get` answers the thread details card's [session details](../user/session-details.md):
a context breakdown and the MCP servers of a thread's provider session. Code:
[`apps/server/src/sessionInsights/`](../../apps/server/src/sessionInsights/), contracts in
[`sessionInsights.ts`](../../packages/contracts/src/sessionInsights.ts).

## Adapter capability

Adapters opt in through the optional `sessionInsights` member of
`ProviderAdapterV2SessionRuntime`, with optional `contextBreakdown` and `mcpServers` methods. A
provider implements only what its protocol exposes: Claude both (SDK `getContextUsage` and
`mcpServerStatus`), Codex and both OpenCode adapters only `mcpServers`. Shared mapping helpers are in
`@t3tools/provider-core/server/sessionInsights`.

## Constraints

- A read never starts or resumes a session. It asks only a live provider session; otherwise it
  answers with the last report it read, marked not live with its capture time. Those reports are
  kept in server memory (200 provider threads), so a server restart forgets them.
- Each part has its own 10-second timeout, and a failed or slow part comes back empty without
  hiding the other.
- MCP status rows can carry a server's configuration, headers included, so they stay out of
  provider logs: Claude's protocol log records only the count, and OpenCode logs nothing.
- The web client queries only while the card is open at full density, and refetches when a turn
  settles or the session status changes. It does not poll.
