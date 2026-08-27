# Desktop remote apps

The TJN desktop distribution exposes ChatGPT as a second top-level surface next to T3 Code. The two surfaces share one Electron `BrowserWindow`; ChatGPT is rendered by exactly one `WebContentsView` attached below the 40px T3 titlebar. The view stays alive while the user returns to T3 Code, so switching surfaces does not recreate the remote session.

ChatGPT uses the dedicated persistent Electron partition `persist:tjn-remote-chatgpt-v1`. The renderer receives shell metadata only: the active surface, a sanitized first-party location and title, navigation affordances, zoom, bounded recents, and categorized error state. Cookies, tokens, message bodies, raw exceptions, and query/hash credentials are never placed in the shell state file.

Navigation is HTTPS-only. First-party ChatGPT/OpenAI hosts remain in the view, exact supported authentication providers are allowed only in a controlled child window, and other HTTPS destinations open in the system browser. Unsafe schemes, untrusted authentication destinations, unknown popups, media capture, and non-approved permissions are denied. Downloads pause for an explicit native save dialog and are never opened automatically.

Remote-app IPC is registered separately from preview IPC. Every command is authorized against the main T3 renderer `webContents` id, so the isolated remote view has no preload and cannot call the bridge. State writes use a same-directory temporary file followed by rename.

The distribution identity is intentionally separate from the upstream app: `T3 Code TJN`, `dev.neuman.t3code`, custom user-data names, and `t3code-tjn` protocol names. Packaged updates use the fork-backed GitHub Releases feed `travisjneuman/t3code`; Nightly builds select the `nightly` prerelease channel. The updater must only install packages built with this same identity. The fork's `TJN Sync Upstream Source` workflow polls `pingdotgg/t3code` every five minutes and performs a non-destructive merge into `main`; conflicts fail before push. The fork-specific macOS Nightly publisher uses a standard GitHub-hosted macOS ARM64 runner, skips unchanged commits, and publishes the merged source as a fork Nightly package without relying on upstream-only Blacksmith runners.

The V1 surface does not scrape ChatGPT DOM or private APIs, intercept remote network traffic, automate the remote page, or claim passkey support for the custom bundle identity.
