# Session search

Fork add-on. `sessionSearch.search` finds sessions from other agents whose messages contain a
query. The sidebar's thread search lists them under T3's own results, and the command palette
adds them as an **Other Agents** group after its own filtering, since the server already matched
them. Each client asks every connected environment and merges the answers, naming hosts that
failed so their matches do not vanish silently. T3's own threads are searched by upstream's
`orchestration.searchThreads`; this add-on adds nothing there.

The search reuses each store's parser from [external sessions](./external-sessions.md) read-only
and keeps no index: it streams the transcripts on every query. Only the directory walk that
lists candidate files is cached briefly, per connection, so typing several queries in a row
walks once. Code:
[`apps/server/src/session-search/`](../../apps/server/src/session-search/). It plugs into the
`core` RPC group, handler, scope and span-label registries; the sidebar and the palette each
mount it with a hook marked `Fork add-on(session-search)`, and the palette line that appends the
group is marked for [other agents](./external-sessions.md), which this add-on depends on.
Without it neither shows other agents' sessions and nothing else changes.

## Scan limits

Codex rollouts dominate: a busy machine writes many gigabytes in the history window, almost all of
it tool output, reasoning, and compaction copies. So a search is bounded by limits, not by the
data (values in the source):

- Only sessions active in the history window, newest first, a few files at a time. Once the
  result limit is reached, files not yet started are older than every match and stay unread.
- A time budget. When it runs out the result says `complete: false`; the sidebar shows
  **Partial** and the palette group "(partial)".
- Files are read in fixed chunks. For stores whose messages are whole on one line (Claude, Codex,
  Pi), a line is parsed only when its raw bytes contain the query's longest run of printable ASCII
  that JSON writers never escape ([`matcher.ts`](../../apps/server/src/session-search/matcher.ts),
  [`transcriptLayout.ts`](../../apps/server/src/session-search/transcriptLayout.ts)). Very long
  lines are skipped unread; the parsers clip messages anyway, so a match past the clip is missed
  either way. Grok splits a reply into chunk lines, so every Grok line is parsed, and an unknown
  driver gets the same safe default.
- Codex lines whose head names a known bulk type are skipped before parsing. That list only
  excludes, so a new Codex line type is parsed rather than lost.
- Antigravity keeps no readable transcript, so it matches on session titles only (snippet source
  `title`).

A client drops a superseded query's atom at once (idle TTL 0), which interrupts the server scan.
An interrupted request is not reported as a failed host.

## Shared with external sessions

- Owned sessions are `ExternalSessions.ownedSessionIds`, the set that keeps them out of the
  sidebar list, so search and the list always agree on what T3 owns. Sessions whose working
  directory is under T3's own state or worktree directories are left out as well.
- Results older than the list's window still open: `subscribeSession` looks up a key it has not
  listed with the same walk and history window
  ([`sessionHistory.ts`](../../apps/server/src/external-sessions/sessionHistory.ts)). Changing
  the window there changes both.
