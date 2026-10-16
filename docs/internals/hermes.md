# Hermes Agent provider (fork add-on)

The `hermes` driver talks to a Hermes Agent that runs elsewhere, usually on another machine, over
its HTTP API. User guide: [Hermes Agent](../user/hermes.md).

## Decisions

- **HTTP only, no host process.** Unlike the CLI providers, nothing is spawned: each T3 thread is
  one Hermes session and each turn one `POST /v1/runs` whose SSE stream the adapter
  ([`packages/provider-hermes/src/server/adapter.ts`](../../packages/provider-hermes/src/server/adapter.ts))
  turns into turn items. Interrupt is `POST /v1/runs/{id}/stop`; Hermes approvals become T3
  approval requests and answer through `/v1/runs/{id}/approval`. Hermes may rotate a session id
  mid-run; the adapter follows the new id.
- **Images go inline in the run request.** Hermes runs on another machine and can't read T3's
  attachment store, so the adapter reads each image on the T3 server and sends it as a
  `data:image/...;base64` `image_url` part in a one-message `input` array. `/v1/runs` passes that
  content to the agent loop without normalizing it, so the parts must already be in the canonical
  Chat Completions shape; a one-message array adds no history, so the session's own history still
  applies. Hermes refuses bodies over 10 MB (`MAX_REQUEST_BYTES`), which base64 reaches at about
  7.5 MB of images; the client refuses a larger request before sending. Steering
  (`/v1/runs/{id}/steer`) takes text only, so a steer carrying an image sends nothing and adds a
  failed item to the running turn instead of failing quietly in the outbox. Any image that can't
  be read or sent fails the turn, never a text-only send.
- **Hermes threads live in Scratch and in their own sidebar section.** `ThreadLaunchService`
  moves any new thread whose instance is a Hermes one into the Scratch project at its root, so the
  model picker and the section's **+** both work without a Hermes project. The main thread list
  filters Hermes threads out and `HermesSidebarSection` lists them merged with
  `GET /api/sessions`, keyed by the session id bound to each thread.
- **Archive state is T3's.** Hermes hides archived sessions from its list, so
  `hermesSessionArchive.ts` keeps id and title of every session archived from T3 in the state dir;
  that file is what Settings › Archived lists.
- **The dashboard is proxied and redacted on the server.** Settings call one RPC that forwards to
  the Hermes dashboard (config, schema, env, custom endpoints) with the stored basic-auth
  credentials. Responses drop Hermes's partial reveals (`*_preview`, `redacted_value`) and
  replace secret-named values; env rows go back as set or unset only. `/api/env/reveal` is never
  called. A config save merges the redacted placeholders back to the stored values before the
  `PUT`, so saving a form never overwrites a secret with the placeholder.
- **Provider terms are enforced in the model list, not left to the user.**
  [`models.ts`](../../packages/provider-hermes/src/server/models.ts) drops Anthropic in every
  form and Google providers signed in through a Google client, and offers only free Kilo
  gateway models. Settings › Models lists those as unavailable. Hiding is T3-only and only
  narrows further: a hidden provider (`hiddenProviders`) is dropped by the server, and a hidden
  model goes through the instance's usual hidden models. Hermes itself is never changed.
- **Text generation is refused.** Every prompt becomes a Hermes session, so titles and commit
  messages would clutter the agent's history.
- **A session from elsewhere is imported in full, then only appended to.**
  [`HermesSessions.ts`](../../apps/server/src/hermes/HermesSessions.ts) maps the session's stored
  messages through
  [`hermesSessionEntries.ts`](../../apps/server/src/hermes/hermesSessionEntries.ts): text,
  reasoning, and each tool call paired with its `tool` result by call id, split into commands and
  dynamic tools the same way the live adapter splits them. Every entry has a stable key, so its
  turn item id never changes and a later click writes only the entries that are new. Positions
  can't be inserted between existing items, so new entries go after the latest run that started
  before them. Entries that fall inside a T3 run's window (with 30 s of clock slack each side) are
  skipped, because that run already streamed them live.
- **Threads from the first import are replaced, not patched.** The v1 import
  (`hermes-session-import:v1` ids) kept only user and assistant text under different ids. A v1 thread with no T3
  runs is rebuilt under `hermes:<instance>:<session>` with the full history, the provider binding
  moves to it, and the old thread is deleted. A v1 thread that has runs is kept and only gets
  entries newer than its last imported item. The provider thread row is keyed by session, so once
  the binding moves only the `import:` id still names the old thread; opening the new thread
  deletes any old copy a failed delete left behind.
- **Cron reports come from the output doc, not the session.** A cron run's delivered text (what
  Discord shows) is written to `{hermes_home}/cron/output/<job>/<local stamp>.md`, not to the
  session. For a `cron_<job>_<date>_<time>` session the import reads the job through the
  dashboard, picks the first doc stamped at or after the session and before the job's next run,
  and adds what follows its last `## Response` as an assistant message after a delivery notice.
  The report is dropped when the session's last assistant message already says the same. Stamps
  are the Hermes host's local time, so only their difference is used, added to the session's
  start. Any failure here only skips the report.
- **Session details come from Hermes, not the run stream.** `SessionInsights.get` calls
  [`insights.ts`](../../packages/provider-hermes/src/server/insights.ts), which reads
  `/api/sessions/{id}`, the paged messages, and the dashboard's `/api/model/info` and
  `/api/mcp/servers` in parallel. Each part can fail alone, and the whole read times out after
  30 s. Hermes sends no token usage for the context window, so the breakdown is a labelled
  four-characters-a-token estimate, and the window size is used only when the dashboard's model
  is the session's. MCP rows read only name, enabled flag and tool count. The report's host is
  the API URL's host, since the agent runs there.
