# Session details

The thread details card can show what the agent's session is doing: its model and status, where it
runs, how full the context window is and what fills it, the MCP servers it loaded, and the files it
changed. Threads of every provider, Hermes threads, and sessions under
[Other Agents](other-agents.md) show the same card.

## Open them

Choose **Toggle thread details** in the thread's header, or press `mod+shift+b`
(`threadPanel.toggle` in [keybindings](keybindings.md)). In a thread, the session details sit
between Automations and Relationships. They appear once a thread has been sent, and only when the
card has room for its full view; in a short window the card keeps to its essentials and leaves them
out. Other Agents sessions share one card, so it stays open or closed as you move between them.

Choose a section's title to collapse it to its heading, and again to expand it. Each section
stays collapsed or expanded across threads and restarts.

## What each section shows

- **Session**: the agent and model with its effort or Fast setting, whether the session is live,
  working, waiting, idle or failed, the permission mode, when it started, the number of turns, and
  tool uses, duration and cost when the provider reports them. A cost marked `~` is the agent's
  own estimate.
- **Environment**: the machine the session runs on, its folder, and its git branch.
- **Context**: how much of the context window is used. Claude threads break it down by category
  (system prompt, tools, MCP tools, memory files, skills, custom agents, messages and free space),
  with dimmed rows for tools that are deferred until needed, tokens left until auto-compact, and
  lists of the MCP tools, memory files, skills and custom agents in context. Other providers show
  token totals instead. A breakdown marked **Estimated**, with `~` before its numbers, was counted
  from the session's stored text rather than reported by the provider; hover the label for what
  it leaves out. **Compact context** compacts the conversation when the provider supports it.
- **Connectors**: the MCP servers the agent itself loaded, with their status (Connected, Pending,
  Needs auth, Failed, Disabled, or Configured when the agent reports only its configuration),
  version and tool count. Hover a failed server to see its error.
- **Outputs**: files the session changed, newest first, with the lines added and removed in all of
  them next to the heading. In a thread, choose a file to open its turn's diff.

## Which providers report what

| Provider              | Context breakdown | Connectors |
| --------------------- | ----------------- | ---------- |
| Claude                | Yes               | Yes        |
| Hermes                | Estimated         | Configured |
| Codex                 | Token totals      | Yes        |
| OpenCode              | Token totals      | Yes        |
| Other providers       | Token totals      | No         |
| Other Agents sessions | Token totals      | No         |

The breakdown and connectors come from the running session. When the session has stopped, the card
shows the last report it read, marked **As of** with its time; sending a message brings it up to
date. Hermes keeps its own record of each session, so a Hermes thread's card reads it from Hermes
whether or not the thread is running: its source, message, tool and API call counts, token totals,
cost, and when it was last active or ended.

## Other Agents sessions

The card reads what the agent's own files record: the model, effort, permission and sandbox modes,
when the session started and was last active, its message or step count, the version of the app
that wrote it, the branch it last ran on, and the context in use at its latest request. Outputs
lists the files its edit and write tools changed, for Claude, Codex, Grok and Pi sessions. In a
long session only the most recent part is read, and the card says so. A file Pi wrote whole has no
line counts. The card updates when a running session stops or an idle one changes.

Session details are not available on mobile.
