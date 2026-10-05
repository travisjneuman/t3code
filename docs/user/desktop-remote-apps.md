# Web apps in ndev.t3code

ndev.t3code can show the ChatGPT, Claude, Grok, Gemini, and Perplexity web apps as top-level desktop surfaces. Use the app switcher in the desktop titlebar to move between ndev.t3code and a site. Switching away keeps each site loaded, so returning is instant and you stay where you were.

Most sites are available when their matching provider is enabled under **Settings → Providers**. Perplexity has no ndev.t3code provider, so it is off until you turn it on:

| Site       | Available when                      |
| ---------- | ----------------------------------- |
| ChatGPT    | The Codex provider is enabled       |
| Claude     | The Claude provider is enabled      |
| Grok       | The Grok Build provider is enabled  |
| Gemini     | The Antigravity provider is enabled |
| Perplexity | You turn it on under **Web apps**   |

To choose which sites appear in the switcher, use the **Show** switches in the **Web apps** section further down **Settings → Providers**. Turning a site off there, or disabling its provider, removes it from the switcher; if you are viewing that site, ndev.t3code switches back to itself. The switcher only lists the places you can go, so the surface you are on is not in the list. Each shown site also has a **Background** switch, on by default: a site loaded in the background shortly after startup is instant to open, but uses about 150–400 MB of memory. Turn it off for sites you rarely use; they load when you open them, and turning it off frees the memory of a site you are not viewing. **Unload idle web apps** (Off, 1h, 4h, or 12h; 4h by default) frees the memory of a site you have not opened for that long. It reloads when you next open it, and is not loaded in the background again until then or until you restart the app.

When a site you are not viewing finishes a reply, a dot appears next to it in the switcher and on the switcher button. Opening the site clears it. Detection follows each site's page layout, so a site redesign can make the dot late or missing.

To bring text from a site into ndev.t3code, select it, right-click, and choose **Send to T3 Thread**. It is added as a quote to the message you are drafting in the thread you were last on, or to a new thread if you had none open. To go the other way, use the send button beside a finished reply's copy button and pick a site: ndev.t3code opens the site and puts the text in its message box for you to review and send. It never sends for you. If the site's message box can't be found, the text is copied to your clipboard so you can paste it.

Sign in on each site's normal page. Every site keeps its own saved session, separate from the others and from your default browser. Sign-in steps through Google, Microsoft, Apple, or X stay inside the desktop app; unrelated links open in your default browser. Page content remains owned and rendered by each site.

Sites follow ndev.t3code's light or dark theme. ChatGPT, Claude, Grok, and Gemini also take on ndev.t3code's colors, and their sidebars match the width of ndev.t3code's sidebar. To change the width, resize the sidebar while ndev.t3code is showing; collapsing it lets each site use its own width. Perplexity keeps its own colors and layout.

When a site is active, the titlebar provides back, forward, reload, retry, zoom, and reset-zoom controls. Downloads always ask where to save the file and are not opened automatically.

Use the clear-session-data control in a site's titlebar (for example “Clear Claude session data”) to sign out of that site and remove its local session data and history. Other sites, ndev.t3code projects, and server data are not affected.

ndev.t3code's maintainer desktop build updates from its configured local source checkout rather than from GitHub Releases. See [Updating ndev.t3code](./updating.md) for how **Check for Updates** follows the upstream nightly release.
