# Agent instructions

Agent instructions are rules T3 Code gives every agent it runs, in every project. Use them for how
you want agents to behave inside T3 Code, such as how to delegate work, without editing your
`CLAUDE.md`, `AGENTS.md`, `~/.claude`, or `~/.codex` files. Those files still apply. Where they
conflict with your agent instructions, agents are told to follow the agent instructions.

## Set them

1. Open **Settings → General** and find **Agent instructions** under **Agents**.
2. Write your instructions. They save when you click outside the box.

Codex, Grok, Cursor, Muse, and OpenCode receive the current text with every turn, so a change
applies from the next message. Claude and Pi get the instructions in their system prompt when the
session starts, so a Claude or Pi thread that is already running keeps the text it started with
until its session restarts, for example after T3 Code restarts. Antigravity doesn't receive agent
instructions.

Keep them short. They're added to every agent's prompt, which costs context in every thread.

Agents started through delegation, such as workers launched with `delegate_task`, get the same
instructions. If a rule is only for the agent that hands out work, say so in the text, for
example: "If your task came from delegate_task, do it yourself and never delegate."

The instructions belong to the environment. Each server you connect to keeps its own, and the
settings scope picker at the top of Settings chooses which ones you're editing. Per-project rules
still belong in that project's `AGENTS.md` or `CLAUDE.md`.

## Example: one orchestrator, many workers

These instructions make the thread's agent plan and review, and hand the work to GPT-6.1 Sol
workers running through Pi:

```text
Inside T3 Code, these instructions supersede conflicting delegation rules in CLAUDE.md or AGENTS.md.
- Delegate with the t3-code delegate_task tool, not native subagents. Default worker target:
  {"providerInstanceId":"pi","model":"openai-codex/gpt-6.1-sol","options":{"thinking":"high"}}.
- Give each worker one short, scoped task with the files it owns, the files it must not touch,
  and what done means. Ask for a short report: changed files, what was verified, open questions.
- Workers are single-use. Each review round is a new delegate_task with the original brief, your
  findings, and any open objections, plus a new clientRequestId. Never message a child thread to
  continue it.
- Use mode "async", then end your turn; finished workers wake you. Do not poll.
- Workers share one checkout: give every brief non-overlapping file ownership.
- You handle git and publishing; workers never commit or push.
- If your task came from delegate_task, do it yourself and never delegate.
```

Change the `providerInstanceId` and `model` to match an instance in **Settings → Providers**.
