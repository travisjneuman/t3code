# Agent instructions

The **Agents** settings control how every agent T3 Code runs behaves, without editing your
`CLAUDE.md`, `AGENTS.md`, `~/.claude`, or `~/.codex` files. Those files still apply. Where they
conflict with these settings, agents are told to follow the settings.

## Set them

Open **Settings → General** and find **Agents**. **Preview** on the **What agents receive** row
shows the exact text these settings produce for the scope you picked.

- **Delegation**: **Off** adds no delegation rules and T3 enforces nothing. **When useful** has the
  thread's agent hand independent pieces of work to workers through the `delegate_task` tool and do
  small or sequential work itself. **Always** keeps the thread's agent to planning, review, and
  integration, and hands the rest to workers.

These rows show while Delegation is on:

- **Worker model**: the provider and model workers run on, including options such as reasoning
  effort. When an agent calls `delegate_task` without a target, T3 runs the worker on this model.
  Leave it off to run workers on the thread's own model. To use GPT-6.1 Sol through Pi, pick the
  Pi instance, the `openai-codex/gpt-6.1-sol` model, and High thinking.
- **Review worker model** and **Research worker model**: a different model for workers started
  with the review or research role. Off uses the worker model.
- **Parallel workers**: the most workers one agent runs at once. T3 refuses a delegation past the
  limit and tells the agent to wait for a worker to finish.
- **Review rounds**: **One round** has a fresh review worker check the finished work once;
  **Until clean** repeats review rounds until one finds nothing to fix. **Agent decides** adds
  nothing.
- **Read-only reviewers**: review and research workers are told not to edit files, commit, or push,
  in their instructions and at the top of their task. This is an instruction, not a sandbox: the
  worker still runs with the thread's permissions.
- **Workers can delegate**: off, T3 refuses `delegate_task` calls from a worker, so only the
  thread's agent hands out work.
- **Orchestrator handles git**: the delegating agent commits and publishes; workers never commit or
  push.

These rows always show:

- **Verification**: **Review only** (read the diff, run no tests or builds), **Targeted checks**
  (the smallest tests and lint that prove the change), or **Full checks** (the project's full
  test, lint, and typecheck before finishing). **Project rules** adds nothing.
- **Commit and push**: **Never** leaves changes uncommitted for you; **After each change** commits
  and pushes each verified change. **Project rules** adds nothing.
- **Additional instructions**: anything else every agent should follow. They're added after the
  rules above and save when you click outside the box.

The worker rules always tell agents to give each worker a scoped brief with non-overlapping files,
to start a new worker for each review round, and to wait for workers to finish instead of polling.

## All projects or one project

The scope picker at the top of Settings chooses what you're editing. With all projects selected you
set the defaults for an environment. Select a project to override any Agents setting for that
project only; the reset arrow beside a row removes the override. Each server you connect to keeps
its own settings.

## When agents pick up changes

Codex, Grok, Cursor, Muse, and OpenCode receive the current instructions with every turn, so a
change applies from the next message. Claude and Pi get them when their session starts, so a Claude
or Pi thread that is already running keeps what it started with until its session restarts, for
example after T3 Code restarts. Antigravity doesn't receive agent instructions.

Workers started with `delegate_task` get the same instructions as the agent that started them.

Keep additional instructions short. They're added to every agent's prompt, which costs context in
every thread.
