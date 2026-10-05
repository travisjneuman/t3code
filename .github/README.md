<div align="center">

<img src="https://raw.githubusercontent.com/travisjneuman/t3code/main/assets/nightly/nightly-web-apple-touch-180.png" width="96" alt="ndev.t3code app icon" />

# ndev.t3code

**A personal fork of [T3 Code](https://github.com/pingdotgg/t3code) with extra add-ons for the desktop app.**

[![Fork of pingdotgg/t3code](https://img.shields.io/badge/fork_of-pingdotgg%2Ft3code-18181b?style=flat-square&logo=github)](https://github.com/pingdotgg/t3code)
[![Tracks upstream nightly](https://img.shields.io/badge/tracks-upstream_nightly-6d5bd0?style=flat-square)](#upstream-sync)
[![Built for macOS](https://img.shields.io/badge/built_for-macOS-3f3f46?style=flat-square&logo=apple)](#build-it-yourself)
[![MIT license](https://img.shields.io/badge/license-MIT-3f3f46?style=flat-square)](https://github.com/travisjneuman/t3code/blob/main/LICENSE)

[What's added](#whats-added) · [Build it yourself](#build-it-yourself) · [Upstream source](https://github.com/pingdotgg/t3code)

</div>

---

Everything T3 Code does comes from the official project at **[pingdotgg/t3code](https://github.com/pingdotgg/t3code)**. Go there to learn about T3 Code itself, its providers, the mobile app and contributing.

This fork follows the upstream nightly and adds the features below. Each add-on lives in its own module, and upstream files get only one-line hooks marked `Fork add-on`. That keeps merges from upstream small.

## What's added

| Add-on                                  | What it does                                                            |
| --------------------------------------- | ----------------------------------------------------------------------- |
| [**Web apps**](#web-apps)               | ChatGPT, Claude, Grok, Gemini and Perplexity as tabs in the desktop app |
| [**Other Agents**](#other-agents)       | Follow and continue sessions you started in other agent apps            |
| [**Compare agents**](#compare-agents)   | One prompt, two models, side by side                                    |
| [**Save to notes**](#save-to-notes)     | Files a thread into your notes folder or Obsidian vault                 |
| [**Export a thread**](#export-a-thread) | Saves a thread's full record as Markdown or JSON                        |
| [**Upstream sync**](#upstream-sync)     | Merges new official nightlies and rebuilds the app from source          |

### Web apps

Open ChatGPT, Claude, Grok, Gemini and Perplexity from the titlebar switcher, right beside T3 Code.

- Each site shows up when its provider is on: ChatGPT with Codex, Claude with Claude, Grok with Grok Build, and Gemini with Antigravity. Perplexity has its own switch.
- Sites follow T3's theme and sidebar width, stay loaded in the background, and show a dot when a reply finishes.
- Text moves both ways. Right-click a selection and choose **Send to T3 Thread**, or send a finished T3 reply into a site's message box.
- Downloaded text files can be added to your draft. ChatGPT and Claude data exports can be turned into Markdown files.

[Guide →](https://github.com/travisjneuman/t3code/blob/main/docs/user/desktop-remote-apps.md)

### Other Agents

Claude Code, Codex, Grok, Pi and Antigravity sessions that you started outside T3 are listed under **Other Agents** in the sidebar. That covers sessions from a terminal, a desktop app or an IDE.

- Follow any session live, or find one through the command palette search.
- **Continue in T3** turns a session into a normal thread with its whole history. The original session stays usable in its own app.
- **Hand back to** gives the session back to the agent it came from. **Move back to Other Agents** undoes the continue.
- Sessions from the Claude desktop app and the Codex app can be opened in those apps, and any session can be archived.

[Guide →](https://github.com/travisjneuman/t3code/blob/main/docs/user/thread-sidebar.md#sessions-from-other-agents)

### Compare agents

Send one prompt to two models and read their answers side by side.

- By default each side gets its own empty folder. You can also have both work in the same project.
- Follow-ups go to both sides. Each side keeps its own model, options and attachments.
- **Review swap** shows each agent the other's answer and asks for its best one.
- Pin, rename, archive or delete a comparison just like a thread. These actions are in its header, on the start page and in the command palette.

[Guide →](https://github.com/travisjneuman/t3code/blob/main/docs/user/compare-agents.md)

### Save to notes

Choose **Save to notes…** in a thread's menu.

- **Summary**: the agent writes a summary note into your notes folder, following that folder's `AGENTS.md` or `CLAUDE.md` rules.
- **Full copy**: saves the thread's prompts and final answers as one Markdown file.

[Guide →](https://github.com/travisjneuman/t3code/blob/main/docs/user/thread-sidebar.md#save-a-thread-to-your-notes)

### Export a thread

Choose **Export…** in a thread's menu to save everything the server stores for that thread, including every run, message, tool call, file change and plan. Pick a readable Markdown transcript or a complete JSON record.

[Guide →](https://github.com/travisjneuman/t3code/blob/main/docs/user/thread-sidebar.md#export-a-thread)

### Upstream sync

The desktop app updates from your own checkout instead of a download feed.

- Every 30 minutes the app merges any new official nightly into the fork and pushes it.
- **Sync & Build** builds the merged source on your Mac. **Restart & Install** then swaps in the new app.
- When needed, Claude Code fixes merge conflicts and build breaks. Nothing is pushed unless the build succeeds.

[Guide →](https://github.com/travisjneuman/t3code/blob/main/docs/user/updating.md#updating-the-fork-from-upstream-nightly)

## Build it yourself

You need macOS, [Vite+](https://viteplus.dev/guide/) (`vp`) and at least one [signed-in provider](https://github.com/pingdotgg/t3code#installation).

```bash
git clone https://github.com/travisjneuman/t3code.git ~/web-dev/t3code
cd ~/web-dev/t3code
vp i
vp run dist:desktop:dmg:arm64   # on an Intel Mac, use dist:desktop:dmg:x64
```

The app is saved in `release/`. **Sync & Build** looks for the checkout at `~/web-dev/t3code`. To keep it somewhere else, set `T3CODE_SOURCE_REPOSITORY_PATH`.

---

<div align="center">
<sub>
Add-ons by <a href="https://github.com/travisjneuman">Travis J. Neuman</a>. Not affiliated with T3 Tools.
T3 Code is © T3 Tools Inc. and <a href="https://github.com/travisjneuman/t3code/blob/main/LICENSE">MIT licensed</a>.
</sub>
</div>
