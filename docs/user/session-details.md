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
out. Other Agents sessions share one card, so it stays open or closed as you move between them. For a
Hermes session you have not opened as a thread, choose **Details** in its sidebar menu to see the
card without importing it.

Choose a section's title to collapse it to its heading, and again to expand it. Each section
stays collapsed or expanded across threads and restarts.

## What each section shows

- **Session**: the agent and model with its effort or Fast setting, whether the session is live,
  working, waiting, idle or failed, and whatever the agent records of these: permission and
  sandbox modes, Remote control, when it started and was last active, the agent's version, turns,
  messages, steps, tool uses and failures, API calls, duration, tokens, cache, reasoning, cost,
  speed, and how much of each usage limit is used with when it resets. A cost marked `~` is an
  estimate, the agent's own or priced by T3 from the token counts.
- **Environment**: the machine the session runs on, its folder, and its git branch.
- **Context**: how much of the context window is used. Claude threads break it down by category
  (system prompt, tools, MCP tools, memory files, skills, custom agents, messages and free space),
  with dimmed rows for tools that are deferred until needed, tokens left until auto-compact
  (**Auto-compacts soon** when little is left), how many times it has compacted, and lists of the
  MCP tools, memory files, skills and custom agents in context. Other providers show token totals,
  and the skills or commands they advertise when they report them. A breakdown marked **Estimated**, with `~` before its numbers, was counted
  from the session's stored text rather than reported by the provider; hover the label for what
  it leaves out. **Compact context** compacts the conversation when the provider supports it.
- **Connectors**: the MCP servers and connectors (claude.ai connectors, Codex apps) the agent
  itself loaded, with their status, version and tool count. A green dot is **Connected**, a
  hollow green ring is **Enabled** (switched on, but the agent doesn't report whether it
  connected), amber is a server that is up but returned an error or **Needs auth**, red is
  **Failed**, blue is **Pending** and grey is **Disabled**. Hover a status to see its error or
  what it means.
- **Outputs**: files the session changed, newest first, with the lines added and removed in all of
  them next to the heading. In a thread, choose a file to open its turn's diff. For Other Agents
  sessions and Hermes, whose edits have no T3 diff, choose a file to open it in your editor.

## Which providers report what

| Provider                              | Context breakdown | Connectors |
| ------------------------------------- | ----------------- | ---------- |
| Claude                                | Yes               | Yes        |
| Hermes                                | Estimated         | Partly     |
| Codex                                 | Token totals      | Yes        |
| OpenCode                              | Token totals      | Yes        |
| Grok, Antigravity, ACP agents, Cursor | Token totals      | Configured |
| Pi, Muse                              | Token totals      | No         |
| Other Agents: Claude                  | Estimated         | Yes        |
| Other Agents: Grok                    | Token totals      | Yes        |
| Other Agents: Codex                   | Token totals      | Configured |
| Other Agents: Pi, Antigravity         | Token totals      | No         |

The breakdown and connectors come from the running session. When the session has stopped, the card
shows the last report it read, marked **As of** with its time, and keeps it after T3 restarts;
sending a message brings it up to date. Hermes keeps its own record of each session, so a Hermes thread's card reads it from Hermes
whether or not the thread is running: its source, message, turn, tool and API call counts, token
totals, cost, when it was last active or ended, and the files its edit tools changed.

## Other Agents sessions

The card reads what the agent's own files record: the model, effort, permission and sandbox modes,
when the session started and was last active, its counts, tokens and cost, the version of the app
that wrote it, the branch it last ran on, and the context in use at its latest request against the
window the agent compacts at. A Claude session also shows Remote control and an **Estimated**
breakdown: its total is measured, and the memory files, skills, agents and messages in it are
counted from their text. Codex sessions show usage limits. A cost with `~` is priced by T3 from
the token counts when the agent records none. Outputs lists the files its edit and write tools
changed over the whole session, including Claude subagents, for Claude, Codex, Grok and Pi
sessions. A file Pi wrote whole has no line counts. While a session runs the card refreshes at
most every 30 seconds as it changes, and again when it stops.

Session details are not available on mobile.
