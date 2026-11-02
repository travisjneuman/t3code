# Agent instructions

The **Agents** settings control how every agent T3 Code runs behaves, without editing your
`CLAUDE.md`, `AGENTS.md`, `~/.claude`, or `~/.codex` files. Those files still apply. Where they
conflict with these settings, agents are told to follow the settings.

## Set them

Open **Settings → General** and find **Agents**. **Preview** on the **What agents receive** row
shows the exact text these settings produce for the scope you picked, including any
provider-specific text.

- **Presets**: picking a preset sets its values in the scope you picked. **Solo** has the agent
  work alone, **Orchestrator** always delegates and runs one review round, and **Review-heavy**
  delegates when useful, reviews until clean, and keeps reviewers read-only. A preset always sets
  every delegation row (Delegation, the worker models, Fixed worker targets, Parallel workers,
  Delegation depth, Worker workspace, Worker time limit, Review rounds, Read-only reviewers,
  Orchestrator handles git, and Block native subagents), using the default for any it doesn't
  store, so switching presets never keeps the previous one's workers. Built-in presets leave the
  worker models and Fixed worker targets as they are. The other rows change only where the preset
  stores a value. Once you change a row, the preset shows **(edited)**: **Save** writes the change
  back to the preset you saved, **Revert** puts its values back, and **Save as…** saves the
  current values under a new name (a saved preset with the same name is replaced; built-in presets
  can't be). Saving or renaming copies that one preset to every connected server the scope picker
  covers, so a thread on any of them can use it; each server keeps its other presets. **Rename**
  renames a preset you saved; threads using it keep it. **Delete** removes a preset you saved from
  those servers, and threads that picked it go back to the default. The row shows **Custom** when
  no preset is selected or matches. **Set default**
  makes the selected preset, built-in or saved, the one every thread on the shown server runs under
  until you pick another for it in the composer; the preset list marks it **(default)**, and
  **Clear default** goes back to the project's settings. While a default preset changes any row,
  the Presets row names it and lists the rows it replaces, and **Preview** includes it.

- **Delegation**: **When useful**, the default, has the thread's agent hand independent pieces of
  work to workers and do small or sequential work itself. It uses its own native subagents or the
  `delegate_task` tool as T3's built-in rules say. **Always** keeps the thread's agent to planning,
  review, and integration, and hands the rest to workers through `delegate_task` instead of native
  subagents. **Off (work alone)** has the agent do everything itself, even where `CLAUDE.md` or
  `AGENTS.md` says to delegate: T3 refuses `delegate_task`, to this environment or another one,
  with a message telling the agent so, and turns off native subagents as **Block native
  subagents** does.

These rows show while Delegation is on:

- **Worker model**: the provider and model workers run on, including options such as reasoning
  effort. When an agent calls `delegate_task` without a target, T3 runs the worker on this model.
  Leave it off to run workers on the thread's own model.
- **Review worker model** and **Research worker model**: a different model for workers started
  with the review or research role. Off uses the worker model.
- **Fixed worker targets**: when on, T3 always uses the configured provider, model, and options
  for each worker role, and rejects a delegation that requests a different target. A role-specific
  model takes precedence; other roles use Worker model. Delegations without a configured target
  are refused. This setting is project-scoped and can be saved in an Agents preset. It does not
  change the thread's main model or provider-native subagents.
- **Parallel workers**: the most workers running at once under one thread's agent, counting
  workers that workers start. The default is 12; pick another count, or **Custom…** to type one
  from 1 to 30. Each worker is a full agent process, so every worker adds memory use (the row
  estimates it) and draws on your plan's limits. T3 refuses a delegation past the limit: an agent
  with workers running is told to wait for one to finish, and one without is told to do that piece
  itself.
- **Delegation depth**: how many levels of workers there can be. The thread's agent's workers are
  level 1. At the default of 1 they can't delegate; at 2 they may start workers of their own,
  which can't go further. Workers decide for themselves whether to delegate, and the top of each
  worker's task says how many levels it has left. T3 refuses a delegation deeper than this.
- **Worker workspace**: **Shared checkout** runs workers in the agent's own checkout, and the
  agent gives each one separate files. **Worktree per worker** makes workers use T3's own worktree
  isolation unless the agent asks for a shared checkout: each new worker gets its own git worktree
  and branch made from the agent's current commit, named like other new worktrees. Uncommitted
  changes aren't in it, so the agent is told to commit what workers need first, and to merge their
  branches when it reviews them. Workers commit only to their own branch and never push.
- **Worker time limit**: T3 stops a worker that's still running after this long, and the agent
  sees it as stopped. Limits are kept in memory, so restarting T3 Code forgets the limits of
  workers already running.
- **Review rounds**: **One round** has a fresh review worker check the finished work once;
  **Until clean** repeats review rounds until one finds nothing to fix. **Agent decides** adds
  nothing.
- **Read-only reviewers**: review and research workers are told not to edit files, commit, or push,
  in their instructions and at the top of their task. This is an instruction, not a sandbox: the
  worker still runs with the thread's permissions.
- **Orchestrator handles git**: the delegating agent commits and publishes; workers never commit or
  push.

These rows always show:

- **Verification**: **Review only** (read the diff, run no tests or builds), **Targeted checks**
  (the smallest tests and lint that prove the change), or **Full checks** (the project's full
  test, lint, and typecheck before finishing). **Project rules** adds nothing.
- **Commit and push**: **Never** leaves changes uncommitted for you; **After each change** commits
  and pushes each verified change. **Project rules** adds nothing.
- **Block native subagents**: agents use only T3's `delegate_task`, never their harness's own
  subagents. T3 turns off Claude's Agent, Task, and Workflow tools and Codex's multi-agent feature;
  other providers are told the rule.
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
agent, and any worker it starts, run under the preset's values on top of the project's settings,
with every delegation row set as picking the preset in Settings would. You can switch it while the
thread runs; see below for when each provider picks it up. A thread you haven't picked one for uses the default preset. **Project settings** keeps the thread
on the project's values even when a default is set. The control shows the preset's name while one
applies. In a narrow composer it's in the **…** menu.

## When agents pick up changes

Codex, Grok, Cursor, Muse, and OpenCode receive the current instructions with every turn, so a
change applies from the next message. Claude restarts its session, keeping the conversation, on
the next message after a change; while it has background work running it keeps the old
instructions until that finishes, but still can't start native subagents once they're turned off.
Pi gets them when its session starts. Codex's multi-agent feature is turned off when its session
starts. Wherever delegation is off, T3 refuses `delegate_task` from the next call. Antigravity
doesn't receive agent instructions.

Workers started with `delegate_task` get the same instructions as the agent that started them, and
run under the preset of the nearest thread above them that has one, else the default preset.

Keep additional instructions short. They're added to every agent's prompt, which costs context in
every thread.
