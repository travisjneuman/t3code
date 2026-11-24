# Save and export threads

## Export a thread

On web and desktop, choose **Export…** from a thread's menu, either by right-clicking it in the
sidebar or from the menu in the thread header. Then pick **Markdown (.md)** or **JSON (.json)**.
Desktop asks where to save the file. A browser saves it like any other download. The file is
named after the thread's title.

To export several threads at once, select them in the sidebar and choose **Export (N)…** from the
selection's menu. Each thread is saved as its own file.

The export is built by the environment from everything it stores for the thread, not just what
your app has loaded.

- **Markdown** is a readable transcript. It starts with the thread's details: project folder,
  model, and where it was forked or imported from. Then it shows every run with its model,
  status, and token usage. It also includes every message, reasoning summary, tool call, command,
  file change, plan, approval, and error, in order. Outputs are kept in full.
- **JSON** is the complete record, for scripts and other tools. It starts with
  `"format": "t3-thread-export"` and a `version`.

Both formats include:

- history the timeline hides, such as turns you rolled back, marked as such
- a fork's inherited history

Attachments are listed by name, without their contents. Both formats leave out:

- long binary data inside tool results, replaced by a short note of its size
- answers you gave to sign-in prompts

The mobile app can't export threads yet.

## Save a thread to your notes

**Save to notes…** in a thread's menu files the thread into a notes folder, such as an Obsidian
vault. It offers **Summary (the agent writes it)** and **Full copy (prompts and answers)**. To save
several threads, select them in the sidebar and choose **Save to notes…** from the selection's
menu, then **Summaries** or **Full copies**.

Set the folders once in **Settings → Threads**: **Notes folder** for summaries and **Saved threads
folder** for full copies. They are paths on the machine that runs the environment. Each must be a
full path, such as `~/notes`, and the folder must already exist. Until a folder is set, saving
asks you to set it first.

If your notes live at a different path on each machine, export the path as an environment variable
on each one (in your shell profile on macOS and Linux, or as a user environment variable on
Windows) and set the folder once under **All environments**, such as `${NOTES_ROOT}/Threads`. If a
machine doesn't set that variable, saving there tells you which one is missing.

- **Summary** sends the thread's agent a message asking it to write a summary note into your
  **Notes folder**. The agent first reads that folder's `AGENTS.md` or `CLAUDE.md`, so a vault with
  its own placement rules gets the note where those rules say. Without those files, the note goes
  at the top of the folder. The agent replies with the note's path. This runs as a normal turn,
  after any work already in progress.
- **Full copy** writes the thread's prompts and final answers, without tool output, to your
  **Saved threads folder** as one Markdown file. Each answer notes the provider and model that
  wrote it. Saving the same thread again replaces its file.
