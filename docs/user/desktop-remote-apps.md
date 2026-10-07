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

To bring text from a site into ndev.t3code, select it, right-click, and choose **Send to T3 Thread**. It is added as a quote to the message you are drafting in the thread you were last on, or to a new thread if you had none open. Headings, lists, code blocks, links, and tables keep their Markdown formatting. **Save Selection as Markdown…** in the same menu saves the selection as a `.md` file instead. To go the other way, use the send button beside a finished reply's copy button and pick a site: ndev.t3code opens the site and puts the text in its message box for you to review and send. It never sends for you. If the site's message box can't be found, the text is copied to your clipboard so you can paste it.

Sign in on each site's normal page. Every site keeps its own saved session, separate from the others and from your default browser. Sign-in steps through Google, Microsoft, Apple, or X stay inside the desktop app; unrelated links open in your default browser. Page content remains owned and rendered by each site.

Sites follow ndev.t3code's light or dark theme. ChatGPT, Claude, Grok, and Gemini also take on ndev.t3code's colors, and their sidebars match the width of ndev.t3code's sidebar. To change the width, resize the sidebar while ndev.t3code is showing; collapsing it lets each site use its own width. Perplexity keeps its own colors and layout.

When a site is active, the titlebar provides back, forward, reload, retry, zoom, and reset-zoom controls. Downloads always ask where to save the file and are not opened automatically. After a text or code file (Markdown, JSON, CSV, and similar) is saved, a notice on the site, or a notification in ndev.t3code once you return, offers **Add to T3 Thread**, which adds the file's contents to your draft as a code block. Files over 200 KB and `.zip` files only offer to show the file in its folder.

To keep your chat history as Markdown, request a data export from ChatGPT or Claude (or export chats from Open WebUI), then use **Import…** under **Import chat export** in the **Web apps** settings. Pick the export's `conversations.json` (on macOS, the unzipped export folder also works) and a destination; ndev.t3code writes one Markdown file per conversation, plus an index, into a new folder there. The import happens on your computer.

Use the clear-session-data control in a site's titlebar (for example “Clear Claude session data”) to sign out of that site and remove its local session data and history. Other sites, ndev.t3code projects, and server data are not affected.

A desktop app you build yourself updates from the checkout it was built from rather than from GitHub Releases. See [Build and update ndev.t3code](./fork-updating.md) for how it follows the upstream nightly release.

## Web apps in the side panel

To use a site beside a thread, open it in the right panel: pick it from the panel's **+** menu or its empty-panel launcher, choose **Open in Side Panel** next to it in the app switcher, or search for "Side Panel" in the command palette. The panel shows the same signed-in site as the full window. There is one panel page per site, which follows you between threads.

A new web app tab is pinned and opens the site's home page. A pinned tab shows in every thread, and while it is the panel's active tab the panel stays open as you switch threads. Use the menu in the tab's header bar to change this:

- **Pin to all threads** turns pinning off or on. Unpinned, the tab stays only in the thread you are on.
- **Same chat in every thread** keeps one page for all threads. **A chat per thread** makes each thread remember the page it was last on in that site. A thread without one opens the home page, and the first chat you open there becomes that thread's chat.
- **This thread** overrides the app setting for the current thread: keep its own chat, use the shared chat, or follow the app setting. **Forget this thread's chat** clears what it remembered.

Closing a pinned web app tab unpins it in every thread; reopen a closed tab like any other panel tab. **Open full window** in the header bar switches to the site's full-window view. Web app tabs are available only in the desktop app.
