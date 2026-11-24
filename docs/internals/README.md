# Internals

Architecture notes and constraints for maintainers and agents. This index belongs to the
ndev.t3code fork; the upstream internals pages are unchanged from upstream T3 Code, and the fork's
own pages are listed separately.

Up: [docs index](../README.md) · [fork landing page](../../.github/README.md). Not here: how to use
a feature ([user guides](../user/README.md)), maintainer procedures
([operations runbooks](#operations-runbooks)), the rules for writing these notes
([documentation rules](../../AGENTS.md#documentation)).

## Upstream internals

- [00 · Glossary](00_glossary.md)
- [01 · Architecture](01_architecture.md)
- [02 · Effect services](02_effect-services.md)
- [03 · Providers](03_providers.md)
- [04 · Environment auth](04_environment-auth.md)
- [05 · Remote environments](05_remote.md)
- [06 · T3 Connect](06_t3-connect.md)
- [07 · Server updates](07_server-updates.md)
- [08 · Product analytics](08_product-analytics.md)
- [09 · Connection runtime](09_connection-runtime.md)
- [10 · Web UI](10_web-ui.md)
- [11 · Mobile layout](11_mobile-layout.md)
- [12 · Mobile navigation](12_mobile-navigation.md)
- [13 · Mobile development lifecycle](13_mobile-development.md)
- [14 · Translating the UI (i18n)](14_i18n.md)
- [15 · Testing](15_testing.md)
- [16 · Performance regression checks](16_performance-regressions.md)
- [17 · Scripts](17_scripts.md)

## Fork internals

Code only the fork has. Start with fork add-ons: it explains how the fork stays mergeable with
upstream and what each other page plugs into.

- [Fork add-ons](fork-add-ons.md): fork-owned files, one-line hooks, the `fork/addons.json`
  manifest, extension points, add-on selection and export, the build-out status, and the marker
  check.
- [Local source updates](local-source-updates.md): how the packaged Mac app merges upstream
  nightlies into its checkout, builds itself, and pushes the fork.
- [External sessions](external-sessions.md): Other Agents, sessions started outside T3 Code.
- [Session search](session-search.md): searching other agents' session messages.
- [Session insights](session-insights.md): the thread details card's live session report.
- [Desktop remote apps](remote-apps.md): web app tabs such as ChatGPT and Claude in the desktop
  app.
- [Hermes Agent provider](hermes.md): a remote Hermes over HTTP, its sidebar section and settings.
- [OpenBot provider](openbot.md): OpenBot's database and local scripts API, conversation binding
  and import.

## Operations runbooks

- [00 · Development and local builds](../operations/00_development.md)
- [01 · Dev container](../operations/01_devcontainer.md)
- [02 · T3 Connect setup](../operations/02_connect-setup.md)
- [03 · Release](../operations/03_release.md)
- [04 · Observability](../operations/04_observability.md)
- [05 · Relay observability](../operations/05_relay-observability.md)
- [Fork host builds and updates](../operations/fork-host-releases.md): building the server on
  other hosts for the same commit as the Mac app (fork add-on).
