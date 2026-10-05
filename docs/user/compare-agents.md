# Compare agents

Compare agents sends one prompt to two models and shows their answers side by side. Use it to see
how different providers, models, or reasoning levels handle the same question.

## Start a comparison

1. Choose the **Compare agents** icon at the bottom of the sidebar, next to Settings and Usage, or
   choose **Compare agents…** in the command palette. From a normal thread, **Compare this thread's
   prompt…** in the palette opens the same form filled in with that thread's project, model, and
   latest prompt.
2. Pick the project, write the prompt, and choose a model for each side. The picker next to each
   model sets its options, such as reasoning effort.
3. Choose **Start comparison**, or press Cmd+Enter (Ctrl+Enter on Windows and Linux).

Each side becomes its own thread, titled `Compare · <model> · <prompt>`. Earlier comparisons are
listed under the form; archive both threads to remove one from the list.

Both agents work in the project folder itself, not in separate worktrees. If the prompt asks them
to change files, they edit the same files at the same time. Comparisons work best for questions,
reviews, and plans.

## Keep going

- The message box at the bottom of the comparison sends one follow-up to both sides.
- **Review swap** sends each agent the other's newest finished answer, naming its provider, model,
  and options, and asks it to compare the two and give its best answer. Run it as many times as you
  like; each round is labelled in both columns.
- While the agents work, the message box's send button becomes a stop button that stops both.

Sending and Review swap wait until both agents have finished. Each agent sees only its own thread, never the
other's, except through Review swap.

## Get back to a comparison

The sidebar's **Compare agents** icon opens the start page, which lists earlier comparisons; choose
one to open it. Inside one of the comparison's threads, the note above the message box has **Open
comparison**, and the command palette has it too. Messages sent from inside a thread go to that
agent only.
