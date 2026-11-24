# Compare agents

Compare agents sends one prompt to two models and shows their answers side by side. Use it to see
how different providers, models, or reasoning levels handle the same question.

## Start a comparison

1. Choose **Compare agents** in the sidebar, next to **Usage**, or choose **Compare agents…** in
   the command palette. From a normal thread, **Compare this thread's
   prompt…** in the palette opens the same form filled in with that thread's project, model, and
   latest prompt.
2. Pick a **Project** or keep **No project**, write the **Prompt**, and choose a model for the
   **Left** and **Right** sides. The picker next to each model sets its options, such as reasoning
   effort. **Swap sides** trades the two choices.
3. Choose **Start comparison**, or press Cmd+Enter (Ctrl+Enter on Windows and Linux).

Each side becomes its own thread, titled `Compare · <model> · <prompt>`, and the two columns show
them the way a thread does: tool work, changed files, images, and the working indicator included.
Choosing a turn's changed files opens that side's thread with its diff.

With **No project**, the default, each agent gets an empty folder of its own, so both can build
something from scratch without getting in each other's way. **No project** is offered only when the
environment has a Scratch folder; otherwise the form starts on your first project, and asks you to
add one if there are none. In a project, both agents work in the project folder itself, not in
separate worktrees: if the prompt asks them to change files, they edit the same files at the same
time, so comparisons in a project work best for questions, reviews, and plans.

Starting a comparison needs operate access on the connection. The sidebar's **Compare agents**
opens comparisons on your primary environment; **Compare this thread's prompt…** uses the
thread's own environment. Comparisons open on web and desktop; the mobile app shows each side as
an ordinary thread.

## Keep going

- The message box at the bottom of the comparison sends one follow-up to both sides. Attach files
  or images with the paperclip, by pasting, or by dropping them on the box; both agents get them.
- Below the box, each side has its own model and options pickers, as in a thread. A change applies
  from the next message on. Switches a thread can't make, such as some provider changes, are
  greyed out with the reason.
- The access level next to the paperclip applies to both agents. Follow-ups always run in Build
  mode.
- **Review swap**, next to the send button, sends each agent the other's newest finished answer,
  naming its provider, model, and options, and asks it to compare the two and give its best
  answer. Run it as many times as you like; later rounds are labeled **Review swap 2**,
  **Review swap 3**, and so on, and each round's message starts with "Review swap" in both
  columns.
- While the agents work, the send button becomes **Stop both**.

Sending and Review swap wait until both agents have finished. Each agent sees only its own thread, never the
other's, except through Review swap.

## Get back to a comparison

The sidebar's **Compare agents** icon opens the start page, which lists earlier comparisons; choose
one to open it. Inside one of the comparison's threads, a note above the message box reads "Part
of a comparison. Messages sent here go to this agent only." The note, the thread's menu (its
title or its sidebar row), and the command palette all have **Open comparison**.

## Manage comparisons

A comparison has most of a thread's actions, applied to both of its threads at once: pin,
settle, snooze and wake, auto-settle, rename, mark unread, export, save to notes, archive, and
**Delete comparison**. Open them from the
comparison's name in the header, from **…** on a row in the start page's list, or by
right-clicking either one. Double-click the name in the header to rename it. The command palette
has **Rename comparison**, **Archive comparison**, and **Delete comparison** for the comparison on
screen or the one the current thread belongs to. Renaming changes the prompt part of both titles and keeps each model.
Delete removes both threads and their history for good; archive keeps them.

Archived comparisons are listed under **Archived comparisons** on the start page, where each can be
unarchived or deleted.
