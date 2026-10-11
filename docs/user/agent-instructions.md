# Agent instructions

The **Agents** settings control how every agent T3 Code runs behaves, without editing your
`CLAUDE.md`, `AGENTS.md`, `~/.claude`, or `~/.codex` files. Those files still apply. Where they
conflict with these settings, agents are told to follow the settings.

## Set them

Open **Settings → General** and find **Agents**. **Preview** on the **What agents receive** row
shows the exact text these settings produce for the scope you picked, including any
provider-specific text.

- **Presets**: pick a preset and click **Apply** to copy its values into the scope you picked.
  **Solo** turns delegation off, **Orchestrator** always delegates and runs one review round, and
  **Review-heavy** delegates when useful, reviews until clean, and keeps reviewers read-only. The
  built-ins change only those rows. **Save current** saves every Agents value for the picked scope
  under a name, on that server; saving under an existing name replaces it, and **Delete** removes
  a preset you saved.

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
- **Worker workspace**: **Shared checkout** runs workers in the agent's own checkout, and the
  agent gives each one separate files. **Worktree per worker** gives each new worker its own git worktree on a new
  `t3/worker-…` branch made from the agent's current commit. Uncommitted changes aren't in it, so
  the agent is told to commit what workers need first, and to merge their branches when it reviews
  them. Workers commit only to their own branch and never push.
- **Worker time limit**: T3 stops a worker that's still running after this long, and the agent
  sees it as stopped. Limits are kept in memory, so restarting T3 Code forgets the limits of
  workers already running.
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
- **Block native subagents**: agents use only T3's `delegate_task`, never their harness's own
  subagents. T3 turns off Claude's Agent and Task tools and Codex's multi-agent feature; other
  providers are told the rule.
- **Autonomy**: **Work without asking** has agents make reasonable calls and list them in the
  report; **Ask before risky steps** has them ask before committing, pushing, deleting, or
  anything that reaches outside your machine; **Ask before any change** has them describe each
  edit and wait for a yes. This is an instruction; the composer's access mode is what enforces
  approvals. **Project rules** adds nothing.
- **Report style**: **Terse**, **Standard**, or **Detailed** final reports. **Project rules** adds
  nothing.
- **Additional instructions**: anything else every agent should follow. They're added after the
  rules above and save when you click outside the box.
- **Provider instructions**: pick a provider and write text only its agents get, after the
  additional instructions. A dot marks providers that have some. Clear the box to remove it.

The worker rules always tell agents to give each worker a scoped brief with non-overlapping files,
to start a new worker for each review round, and to wait for workers to finish instead of polling.

## All projects or one project

The scope picker at the top of Settings chooses what you're editing. With all projects selected you
set the defaults for an environment. Select a project to override any Agents setting for that
project only; the reset arrow beside a row removes the override. Each server you connect to keeps
its own settings.

## A preset for one thread

The people icon in the composer, next to the access mode, picks a preset for that thread only. Its
agent, and any worker it starts, run under the preset's values on top of the project's settings.
**Project settings** goes back to the project's values. The control shows the preset's name while
one is picked. In a narrow composer it's in the **…** menu.

## When agents pick up changes

Codex, Grok, Cursor, Muse, and OpenCode receive the current instructions with every turn, so a
change applies from the next message. Claude and Pi get them when their session starts, so a Claude
or Pi thread that is already running keeps what it started with until its session restarts, for
example after T3 Code restarts. Antigravity doesn't receive agent instructions.

Workers started with `delegate_task` get the same instructions as the agent that started them.

Keep additional instructions short. They're added to every agent's prompt, which costs context in
every thread.
