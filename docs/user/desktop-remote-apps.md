# Provider web apps in ndev.t3code

ndev.t3code can show the ChatGPT, Claude, Grok, and Gemini web apps as top-level desktop surfaces. Use the app switcher in the desktop titlebar to move between ndev.t3code and a site. Switching away keeps each site loaded, so returning is instant and you stay where you were.

A site appears in the switcher when its matching provider is enabled and signed in under **Settings → Providers**:

| Site    | Provider    |
| ------- | ----------- |
| ChatGPT | Codex       |
| Claude  | Claude      |
| Grok    | Grok Build  |
| Gemini  | Antigravity |

Disabling a provider or signing it out removes its site from the switcher. A site you are currently viewing stays until you switch away.

Sign in on each site's normal page. Every site keeps its own saved session, separate from the others and from your default browser. Sign-in steps through Google, Microsoft, Apple, or X stay inside the desktop app; unrelated links open in your default browser. Page content remains owned and rendered by each site.

Sites follow ndev.t3code's light or dark theme. ChatGPT also picks up ndev.t3code's colors; the other sites keep their own look in the matching theme.

When a site is active, the titlebar provides back, forward, reload, retry, zoom, and reset-zoom controls. Downloads always ask where to save the file and are not opened automatically.

Use the clear-session-data control in a site's titlebar (for example “Clear Claude session data”) to sign out of that site and remove its local session data and history. Other sites, ndev.t3code projects, and server data are not affected.

ndev.t3code's maintainer desktop build updates from its configured local source checkout rather than from GitHub Releases. See [Updating ndev.t3code](./updating.md) for how **Check for Updates** follows the upstream nightly release.
