# Session search

Fork add-on. `sessionSearch.search` finds sessions from other agents whose messages contain a
query, for the sidebar's thread search and the command palette (which appends the server's
results after its own filtering, since the server already matched them). It reuses each store's parser from
[external sessions](./external-sessions.md) read-only, and keeps no index: it streams the
transcripts on every query. Code: [`apps/server/src/session-search/`](../../apps/server/src/session-search/).

## Scan limits

Codex rollouts dominate: a busy machine writes many gigabytes in 90 days, almost all of it tool
output, reasoning, and compaction copies. So a search is bounded by limits, not by the data:

- Sessions active in the last 90 days, newest first, read four at a time. Once 50 sessions match,
  files not yet started are older than every match and stay unread.
- An 8-second budget. When it runs out the result says `complete: false`, and the sidebar shows
  **Partial**.
- Files are read in 1 MiB chunks. For stores whose messages are whole on one line (Claude, Codex,
  Pi), a line is parsed only when its raw bytes contain the query's longest run of printable ASCII
  that JSON writers never escape (`transcriptLayout.ts`). Lines over 2 MiB are skipped; the
  parsers clip messages to 20,000 characters, so a match past that point is missed either way.
  Grok splits a reply into chunk lines, so every Grok line is parsed.
- Codex lines whose head names a known bulk type are skipped before parsing. That list only
  excludes, so a new Codex line type is parsed rather than lost.

A client drops a superseded query's atom at once (idle TTL 0), which interrupts the server scan.

## Shared with external sessions

- Owned sessions are `ExternalSessions.ownedSessionIds`, the set that keeps them out of the
  sidebar list, so search and the list always agree on what T3 owns.
- Results older than the list's 14 days still open: `subscribeSession` looks up a key it has
  not listed with the same walk and 90-day window
  ([`sessionHistory.ts`](../../apps/server/src/external-sessions/sessionHistory.ts)). Changing
  the window there changes both.
