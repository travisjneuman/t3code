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
  gateway models. The Settings checklist shows those as locked; the user's own hidden list only
  narrows further.
- **Text generation is refused.** Every prompt becomes a Hermes session, so titles and commit
  messages would clutter the agent's history.
