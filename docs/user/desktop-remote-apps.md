# ChatGPT in ndev.t3code

ndev.t3code includes ChatGPT as a top-level desktop surface. Use the app switcher in the desktop titlebar to move between ndev.t3code and ChatGPT. Returning to ndev.t3code keeps the ChatGPT session available for the next switch.

Sign in using the normal ChatGPT page. Supported sign-in windows are kept inside the desktop app for the authentication flow; unrelated links open in your default browser. ChatGPT page content remains owned and rendered by ChatGPT.

When ChatGPT is active, the titlebar provides back, forward, reload, retry, zoom, and reset-zoom controls. Downloads always ask where to save the file and are not opened automatically.

Use “Clear ChatGPT session data” in the ChatGPT controls to remove the dedicated local session data and shell metadata for this surface. This does not remove ndev.t3code projects or server data.

ndev.t3code's maintainer desktop build updates from its configured local source checkout rather than from GitHub Releases. Open **Settings → About** and use **Check for Updates**. When upstream changes are available, **Sync & Build** fetches the upstream source, merges it with the fork's local commits, and builds a new app on the same Mac. **Restart & Install** then replaces the installed app from that local build and reopens ndev.t3code.

The local update is deliberately fail-closed. It pauses when the checkout is not on the maintainer branch, has uncommitted or untracked files, is already in a merge, or does not have the expected fork and upstream remotes. A merge conflict is aborted and leaves the checkout unchanged. Running tasks are interrupted only after the local build has completed and you confirm the restart. This path does not use GitHub Actions, hosted runners, release publishing, or deployment workflows.

The fork remains based on [the original T3 Code repository](https://github.com/pingdotgg/t3code), and the local update can push the completed merge back to the fork's `main` branch. All GitHub Actions workflows for this fork are disabled; source synchronization and app builds happen on the maintainer's Mac. Fork packages without Apple Developer signing remain unnotarized, so macOS may reject a directly downloaded copy even when the bundle passes structural validation.
