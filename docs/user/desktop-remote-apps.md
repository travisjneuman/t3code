# ChatGPT in T3 Code TJN

T3 Code TJN includes ChatGPT as a top-level desktop surface. Use the app switcher in the desktop titlebar to move between T3 Code and ChatGPT. Returning to T3 Code keeps the ChatGPT session available for the next switch.

Sign in using the normal ChatGPT page. Supported sign-in windows are kept inside the desktop app for the authentication flow; unrelated links open in your default browser. ChatGPT page content remains owned and rendered by ChatGPT.

When ChatGPT is active, the titlebar provides back, forward, reload, retry, zoom, and reset-zoom controls. Downloads always ask where to save the file and are not opened automatically.

Use “Clear ChatGPT session data” in the ChatGPT controls to remove the dedicated local session data and shell metadata for this surface. This does not remove T3 Code projects or server data.

T3 Code TJN updates from the TJN fork's GitHub Releases feed, using the same custom app identity and data location. Open **Settings → About**, choose **Nightly** under **Update track**, and use **Check for Updates**. Nightly builds select the prerelease feed automatically; downloaded updates are verified by the Electron updater and require a restart to install. Fork packages without Apple Developer signing remain unnotarized, so macOS may reject a directly downloaded copy even when the bundle passes the updater's structural validation.

The GitHub **Sync fork** action and the desktop updater are separate operations. This fork includes a `TJN Sync Upstream Source` workflow that checks `pingdotgg/t3code` every five minutes and merges upstream `main` while preserving the TJN commits. GitHub schedules are best-effort; a real merge conflict stops the workflow for safe manual resolution. The fork also includes a macOS ARM64 Nightly publisher on a standard GitHub-hosted runner. It publishes only when `main` has changed, so T3 Code TJN can download the current fork package from the prerelease feed without depending on the upstream-only Blacksmith runner pool. The updater downloads only TJN-identical packaged releases; it never installs the upstream app binary across the custom identity boundary.
