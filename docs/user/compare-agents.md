# Compare agents

Compare agents sends one prompt to two models and shows their answers side by side. Use it to see
how different providers, models, or reasoning levels handle the same question.

## Start a comparison

1. Choose the **Compare agents** icon at the bottom of the sidebar, next to Settings and Usage, or
   choose **Compare agents…** in the command palette. From a normal thread, **Compare this thread's
   prompt…** in the palette opens the same form filled in with that thread's project, model, and
   latest prompt.
2. Keep **No project** or pick a project, write the prompt, and choose a model for each side. The picker next to each
   model sets its options, such as reasoning effort.
3. Choose **Start comparison**, or press Cmd+Enter (Ctrl+Enter on Windows and Linux).

Each side becomes its own thread, titled `Compare · <model> · <prompt>`, and the two columns show
them the way a thread does: tool work, changed files, images, and the working indicator included.
Choosing a turn's changed files opens that side's thread with its diff.

With **No project**, the default, each agent gets an empty folder of its own, so both can build
something from scratch without getting in each other's way. In a project, both agents work in the
project folder itself, not in separate worktrees: if the prompt asks them to change files, they
edit the same files at the same time, so there comparisons work best for questions, reviews, and
plans.

## Keep going

- The message box at the bottom of the comparison sends one follow-up to both sides. Attach files
  or images with the paperclip, by pasting, or by dropping them on the box; both agents get them.
- Below the box, each side has its own model and options pickers, as in a thread. A change applies
  from the next message on. Switches a thread can't make, such as some provider changes, are
  greyed out with the reason.
- **Build**/**Plan** and the access level next to the paperclip apply to both agents.
- **Review swap**, next to the send button, sends each agent the other's newest finished answer, naming its provider, model,
  and options, and asks it to compare the two and give its best answer. Run it as many times as you
  like; each round's message starts with "Review swap" in both columns.
- While the agents work, the message box's send button becomes a stop button that stops both.

Sending and Review swap wait until both agents have finished. Each agent sees only its own thread, never the
other's, except through Review swap.

## Get back to a comparison

The sidebar's **Compare agents** icon opens the start page, which lists earlier comparisons; choose
one to open it. Inside one of the comparison's threads, the note above the message box has **Open
comparison**, and the command palette has it too. Messages sent from inside a thread go to that
agent only.

## Manage comparisons

A comparison has the same actions as a thread, applied to both of its threads at once: pin,
settle, snooze, rename, mark unread, export, save to notes, archive, and delete. Open them from the
comparison's name in the header, from **…** on a row in the start page's list, or by
right-clicking either one. Renaming changes the prompt part of both titles and keeps each model.
Delete removes both threads and their history for good; archive keeps them.

Archived comparisons are listed under **Archived comparisons** on the start page, where each can be
unarchived or deleted.
