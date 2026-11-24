# Hermes Agent provider (fork add-on)

The `hermes` driver talks to a Hermes Agent that runs elsewhere, usually on another machine, over
its HTTP API. User guide: [Hermes Agent](../user/hermes.md).

The driver is its own package, `@t3tools/provider-hermes`, registered in `builtInDrivers.ts`
like a built-in one; its sessions service, RPCs, archived panel, insights reader and
own-workspace flag go through the `core` registries. What is left in upstream files is marked
`Fork add-on(hermes)` and listed in [`fork/addons.json`](../../fork/addons.json): on the server
the Scratch move in `ThreadLaunchService`, the MCP bridge in `McpHttpServer.ts` and `server.ts`,
the Codex model merge in `ProviderRegistry`, the settings secret client and the not-sent turn
failure; in contracts the driver kind, default model and usage provider; on the web the sidebar
section, the model picker's grouped sections, the composer and draft headline, the fixed run
location, the details panel and the provider settings card. Left out, there is no Hermes driver
and nothing else changes.

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
  applies. Hermes refuses bodies over 10 MB (its `MAX_REQUEST_BYTES`), which base64 reaches at
  about 7.5 MB of images; the client refuses a larger request before sending, as a turn that was
  never sent. Steering
  (`/v1/runs/{id}/steer`) takes text only, so a steer carrying an image sends nothing and adds a
  failed item to the running turn instead of failing quietly in the outbox. Any image that can't
  be read or sent fails the turn, never a text-only send.
- **Hermes threads live in Scratch and in their own sidebar section.** `ThreadLaunchService`
  moves any new thread whose instance is a Hermes one into the Scratch project at its root, so the
  model picker and the section's **+** both work without a Hermes project. The main thread list
  filters Hermes threads out and `HermesSidebarSection` lists them merged with
  `GET /api/sessions`, keyed by the session id bound to each thread.
- **A Hermes thread runs on Hermes's machine, not the T3 project.** The chat view resolves a
  Hermes selection
  ([`hermesChatPresentation.ts`](../../apps/web/src/fork-chat/hermesChatPresentation.ts)) to a
  fixed run location named after the Hermes host, so the composer never offers another
  environment and draft routing never moves the draft, and the details panel hides every local
  workspace control (environment, Open in, scripts, branch, pull requests, git). Those would act
  on a checkout Hermes never sees.
- **Archive state is T3's.** Hermes hides archived sessions from its list, so
  `hermesSessionArchive.ts` keeps id and title of every session archived from T3 in the state dir;
  that file is what Settings › Archive lists.
- **The dashboard is proxied and redacted on the server.** Settings call one RPC that forwards to
  the Hermes dashboard (config, schema, env, custom endpoints) with the stored basic-auth
  credentials. Responses drop Hermes's partial reveals (`*_preview`, `redacted_value`); env rows
  go back as set or unset only, and `/api/env/reveal` is never called. Everything else is redacted
  by field meaning
  ([`hermesDashboardRedaction.ts`](../../apps/server/src/hermes/hermesDashboardRedaction.ts)): a
  key is secret by its head noun (`token`, `secret`, `password`, `authorization`, `cookie`, a
  qualified `*_key`), so counts like `max_tokens` and flags like `has_api_key` survive. Header
  maps, `{name, value}` pairs with a secret name, and the `value`/`default` of a secret-named
  object are hidden, and credentials inside plain strings (URL passwords, secret query params,
  `Bearer` values, known key shapes) are masked in place. A config save restores unchanged
  placeholders from the stored config and refuses one whose surrounding text was edited, so a
  placeholder can never overwrite a secret.
- **Session listings are coalesced and cached for a few seconds per instance.** The cache key
  fingerprints the instance's bound T3 threads and their latest run, so a T3 turn on one instance
  re-reads only that Hermes, and T3-side session changes invalidate the instance. A listing has one
  overall deadline; the subagent walk gets only what is left and degrades to no nesting. The sidebar
  re-lists only the instances whose threads changed; focus and Refresh re-list all of them.
- **The T3 tools bridge acts as the instance's running thread.** Hermes's MCP config is global
  and its runs carry no headers, so one bridge key per Hermes instance stands for that instance
  ([`HermesMcpBridge.ts`](../../apps/server/src/hermes/HermesMcpBridge.ts)). Each call acts as the
  instance's one T3 thread that is running a turn, so parent links, liveness and mode caps follow
  the normal thread-caller paths; with no such thread, or several, the call is refused rather than
  guessed.
- **The T3 tool allowlist is enforced at call time.** Hermes's `tools.include` lists
  `HERMES_T3_TOOLS`, but a Hermes that ignores or loses it would otherwise reach every
  orchestration tool its thread scope allows. Every bridged request passes
  `refuseUnboundRequest`, which refuses a bound caller's `tools/call` for any other tool with a
  tool error. `tools/list` is not filtered.
- **Provider terms are enforced in the model list, not left to the user.**
  [`models.ts`](../../packages/provider-hermes/src/server/models.ts) drops Anthropic in every
  form and Google providers signed in through a Google client, and offers only free Kilo
  gateway models. Settings › Providers › Hermes Agent › Models lists those as unavailable. Hiding is T3-only and only
  narrows further: a hidden provider (`hiddenProviders`) is dropped by the server, and a hidden
  model goes through the instance's usual hidden models. Hermes itself is never changed.
- **Hermes's Codex group borrows T3's live Codex list.** Hermes lists account-gated Codex models
  only while its own Codex sign-in is fresh, and its picker never renews that sign-in. Wherever
  the provider registry merges snapshots,
  [`hermesAccountCodexModels.ts`](../../apps/server/src/provider/hermesAccountCodexModels.ts) adds
  the models a signed-in, ready T3 Codex instance lists and Hermes's Codex group lacks, so either
  provider's refresh updates the group. A Hermes Codex group that is signed out or hidden stays
  absent.
- **Usage comes from Hermes's own counters.** Hermes keeps cumulative tokens and cost per
  session and lists sessions most recently active first, so a Usage refresh pages only until it
  reaches sessions it already holds, re-reading a margin because offset paging can miss a session
  that moved to the top mid-read
  ([`usage.ts`](../../packages/provider-hermes/src/server/usage.ts)). A zero cost means Hermes had
  no price, so shared pricing estimates it. A remote Hermes is fingerprinted by its URL, so
  environments that reach the same Hermes count it once; a loopback Hermes is a different one on
  each environment.
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
  before them. Entries that fall inside a T3 run's window are skipped, because that run already
  streamed them live; the window has generous slack each side, since Hermes usually runs on another
  machine with its own clock.
- **A compressed conversation is one listed session over several segments.** Hermes lists only
  the newest segment, and its messages endpoint returns the whole chain, root to tip. Compression
  copies the last tool calls and their results into the next segment under the same call ids, so
  the import keeps the first copy of each call; two entries with one key would write one event id
  twice and fail the whole import. Hermes deletes one segment at a time, and deleting only the
  newest would list the one before it, so Delete deletes every segment the messages name, newest
  first. Hermes leaves branches and subagents out of that chain; Archive needs none of this,
  because Hermes archives the whole chain itself.
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
- **Session details come from Hermes, not the run stream.** Hermes keeps its own session
  store, so the details card reads it over HTTP whether or not T3 runs the session, through the
  reader Hermes registers in `forkInsightsReaders.ts`. What it reads and how it estimates the
  context are in [Session insights › Hermes](./session-insights.md#hermes).
