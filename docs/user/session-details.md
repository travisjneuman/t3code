# Session details

The thread details card can show what the agent's session is doing: its model and status, how full
the context window is and what fills it, the MCP servers it loaded, and the files it changed.

## Open them

Choose **Toggle thread details** in the thread's header, or press `mod+shift+b`
(`threadPanel.toggle` in [keybindings](keybindings.md)). The session details sit between
Automations and Relationships. They appear once a thread has been sent, and only when the card has
room for its full view; in a short window the card keeps to its essentials and leaves them out.

## What each section shows

- **Session**: the provider and model with its effort or Fast setting, whether the session is live,
  working, waiting, idle or failed, the permission mode, when it started, the number of turns, and
  tool uses, duration and cost when the provider reports them.
- **Context**: how much of the context window is used. Claude threads break it down by category
  (system prompt, tools, MCP tools, memory files, skills, custom agents, messages and free space),
  with dimmed rows for tools that are deferred until needed, tokens left until auto-compact, and
  lists of the MCP tools, memory files, skills and custom agents in context. Other providers show
  token totals instead. **Compact context** compacts the conversation when the provider supports it.
- **Connectors**: the MCP servers the agent itself loaded, with their status (Connected, Pending,
  Needs auth, Failed or Disabled), version and tool count. Hover a failed server to see its error.
- **Outputs**: files the thread's turns changed, newest first. Choose one to open its turn's diff.

## Which providers report what

| Provider   | Context breakdown | Connectors |
| ---------- | ----------------- | ---------- |
| Claude     | Yes               | Yes        |
| Codex      | Token totals      | Yes        |
| OpenCode   | Token totals      | Yes        |
| All others | Token totals      | No         |

The breakdown and connectors come from the running session. When the session has stopped, the card
shows the last report it read, marked **As of** with its time; sending a message brings it up to
date. Session details are not available on mobile.
