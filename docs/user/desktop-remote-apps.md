# Web apps in ndev.t3code

ndev.t3code's desktop app can show the ChatGPT, Claude, Grok, Gemini, and Perplexity web apps as top-level surfaces. Use the app switcher in the desktop titlebar to move between ndev.t3code (listed as **Code**) and a site. Switching away keeps each site loaded, so returning is instant and you stay where you were. Web apps are desktop-only; the web and mobile apps don't show them.

Most sites are available when their matching provider is enabled under **Settings → Providers**. Perplexity has no ndev.t3code provider, so it is off until you turn it on:

| Site       | Available when                      |
| ---------- | ----------------------------------- |
| ChatGPT    | The Codex provider is enabled       |
| Claude     | The Claude provider is enabled      |
| Grok       | The Grok provider is enabled        |
| Gemini     | The Antigravity provider is enabled |
| Perplexity | You turn it on under **Web apps**   |

## Choose which sites load

The **Web apps** section further down **Settings → Providers** appears in the desktop app while you are viewing its own environment. Each site has three controls:

- **Show** puts the site in the switcher. Turning it off, or disabling the site's provider, removes it; if you are viewing that site, ndev.t3code switches back to itself. The switcher only lists the places you can go, so the surface you are on is not in the list.
- **Background**, on by default, loads the site shortly after startup so it opens instantly. Each loaded site uses about 150–400 MB of memory. Turn it off for sites you rarely use; they load when you open them, and turning it off frees the memory of a site you are not viewing.
- **Text** sizes the site's text relative to ndev.t3code: −20%, −10%, **Match T3**, +10%, or +20%.

**Unload idle web apps** (Off, 1h, 4h, or 12h; 4h by default) frees the memory of a site you have not opened for that long. It reloads when you next open it, and is not loaded in the background again until then or until you restart the app. A site whose page fails to load or crashes reloads when you switch back to it.

When a site you are not viewing finishes a reply, a dot appears next to it in the switcher and on the switcher button. Opening the site clears it. Detection follows each site's page layout, so a site redesign can make the dot late or missing.

## Move text between a site and a thread

To bring text from a site into ndev.t3code, select it, right-click, and choose **Send to T3 Thread**. It is added as a quote to the message you are drafting in the thread you were last on, or to a new thread in your default project if you had none open. Headings, lists, code blocks, links, and tables keep their Markdown formatting. **Save Selection as Markdown…** in the same menu saves the selection as a `.md` file instead.

To go the other way, use **Send to a web app** beside a finished reply's copy button and pick a site. ndev.t3code opens the site and puts the text in its message box for you to review and send; it never sends for you. If the site's message box can't be found, the text is copied to your clipboard so you can paste it.

## Sign-in, look, and text size

Sign in on each site's normal page. Every site keeps its own saved session, separate from the others and from your default browser. Sign-in steps through Google, Microsoft, Apple, or X stay inside the desktop app; other links open in your default browser, and the right-click menu also has **Open Link in Browser** and **Copy Link**. Page content remains owned and rendered by each site.

Sites follow ndev.t3code's light or dark theme and take on its colors, and their sidebars match the width of ndev.t3code's sidebar. To change the width, resize the sidebar while ndev.t3code is showing; collapsing it lets each site use its own width.

Each site's text is sized to match ndev.t3code's chat text, both in the full window and in the side panel. It follows **Interface font size** under **Settings → Appearance** and the app zoom (**View → Zoom In / Zoom Out / Actual Size**), so the two stay matched as you zoom. To make one site's text larger or smaller, use its **Text** choice in the **Web apps** settings, **Text size** in the side panel's menu, or **Text Size** in the site's right-click menu. **View → Web App Text Larger / Web App Text Smaller / Web App Text Matches T3** change the site you are using: ⌥⌘= / ⌥⌘− / ⌥⌘0 on macOS, Ctrl+Alt+= / Ctrl+Alt+− / Ctrl+Alt+0 on Windows and Linux. The command palette offers **Match <site> Text to T3** for any site you have changed.

## Downloads and chat exports

Downloads always ask where to save the file and are not opened automatically. After a text or code file (Markdown, JSON, CSV, and similar) is saved, a notice on the site offers **Add to T3 Thread**, and a notification in ndev.t3code once you return offers **Add to thread**; either adds the file's contents to your draft as a code block. Files over about 200 KB and `.zip` files only offer to show the file in its folder.

To keep your chat history as Markdown, request a data export from ChatGPT or Claude (or export chats from Open WebUI), then use **Import…** under **Import chat export** in the **Web apps** settings. Pick the export's `conversations.json` or Open WebUI's `.json` file (on macOS, the unzipped export folder also works) and a destination; ndev.t3code writes one Markdown file per conversation, plus an index, into a new folder there. The import happens on your computer.

## Web apps in the side panel

To use a site beside a thread, open it in the right panel: pick it from the panel's **+** menu or its empty-panel launcher, choose **Open in Side Panel** next to it in the app switcher, or choose **Open <site> in Side Panel** in the command palette. The panel shows the same signed-in site as the full window. There is one panel page per site, which follows you between threads. The header bar has **Back**, **Forward**, **Reload**, and **Open full window**, which switches to the site's full-window view.

A new web app tab is pinned and opens the site's home page. A pinned tab shows in every thread, and while it is the panel's active tab the panel stays open as you switch threads. Use the site's menu in the header bar to change this:

- **Pin to all threads** turns pinning off or on. Unpinned, the tab stays only in the thread you are on.
- Under **App chat**, **Same chat in every thread** keeps one page for all threads. **A chat per thread** makes each thread remember the page it was last on in that site. A thread without one opens the home page, and the first chat you open there becomes that thread's chat.
- **This thread** choices override the app setting for the current thread: follow the app setting, keep its own chat, or use the shared chat. **Forget this thread's chat** clears what it remembered.

Closing a pinned web app tab unpins it in every thread; reopen a closed tab like any other panel tab. Web app tabs work only in the desktop app; elsewhere a web app tab shows "Available in the desktop app."
