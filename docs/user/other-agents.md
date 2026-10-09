# Sessions from other agents

**Other Agents**, below your threads in the sidebar, lists sessions you started outside T3 and
used in the last 14 days, such as Claude Code or Codex in a terminal, a desktop app, or an IDE.
Codex threads stay listed until you archive them in Codex. Open one to follow it live. Older
sessions are still found by search. Sessions running right now
come first and stay in view even when you collapse the list; the header counts them as active.
Each session takes one line; hover it for its folder, model and machine. Below the running ones
are the sessions active in the last 24 hours, then **Earlier**, which starts collapsed. Runs that
the sidebar's sync button starts to finish an upstream merge are named by when they started, such
as **t3 100626 143205** for October 6, 2026 at 14:32:05.

A session's view shows its latest 200 messages. **Continue in T3** brings over the whole history.
In the desktop app, the view has the right panel for [web apps](./desktop-remote-apps.md), one
panel shared by every session; the browser, terminal, files and diff need a thread, so continue the
session in T3 for those.

## Continue a session in T3

To keep working on a Claude, Codex, Grok or Pi session in T3, stop it in the other app, then
choose **Continue in T3**. The session becomes a regular thread in its folder's project, with its
history, and leaves the Other Agents list. It stays where it is: T3 resumes the same session, so
you can go back to the other app later and pick it up there. What you send from the other app
afterwards shows up in the T3 thread too. Send from one app at a time: while the other app is
working in the session, the thread warns you above the composer. Antigravity sessions can be
followed but not continued, because T3 runs Antigravity with its own session store.

A continued thread shows a small import icon in the sidebar, and its hover card says which agent
it came from. You can switch it to another agent with the model picker; the new agent gets the
session's whole history, including what happened before T3. Its own turns stay in T3, though: the
original session only records turns its own agent ran. Before going back to the other app,
right-click the thread and choose **Hand back to** the original agent. T3 sends a short "Handing
back" message on the model and reasoning level the session was continued with, the agent is told
what the other agents did, and that turn is saved in the original session. The item shows only
while the thread is set to a different agent, and it is not on mobile yet.

Continued a session by mistake, or done with it in T3? Right-click the thread and choose **Move
back to Other Agents**. Nothing is sent: the thread is archived and the session is listed under
Other Agents again. Choosing **Continue in T3** on it later brings the same thread back. Archiving
a continued thread any other way does the same.

## Archive a session

Right-click a session to continue it, copy its session ID or folder path, open its folder, or
archive it. Archiving only takes the session off T3's list: it stays where it is in the agent's
own app. A running session can't be archived until it stops, and an archived session that runs
again comes back to the list on its own. Archived sessions are listed in **Settings › Archived**,
where **Unarchive** brings them back. Right-click the **Other Agents** header and choose **Show
archived sessions** to go there.

Claude sessions you archive in the Claude desktop app leave the list too and show in **Settings ›
Archived** marked as archived in Claude desktop. Unarchive those in Claude; they come back here
within a few seconds. Sessions you delete in the Claude desktop app leave the list as well.

## Open a session in its own app

Sessions from the Claude desktop app or the Codex app open in that app on the same session: click
**Claude Desktop** or **Codex Desktop** under the session, or right-click the row and choose
**Open in**. The app opens on the computer running T3, and Claude needs deep links turned on and
you signed in. That is also where you stop a running session; T3 can't stop a session another app
is running. Sessions from a terminal or an IDE have no such link.

## Search other agents' sessions

On web and desktop, the sidebar's **Search** box searches threads across connected environments,
like the command palette (`Cmd/Ctrl+K`). Both also list matching sessions under **Other
Agents**: Claude Code, Codex, Grok, and Pi sessions from the last 90 days whose
messages contain the text, and Antigravity sessions by title. Sessions that continue in T3 show
up as threads instead. With very large session histories, the newest sessions are searched
first; **Partial** means older ones weren't reached, and the palette labels the group **Other
Agents (partial)**.
