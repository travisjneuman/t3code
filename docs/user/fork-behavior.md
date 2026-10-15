# Where ndev.t3code differs from T3 Code

A few upstream features behave differently in this fork. The upstream guides describe T3 Code as
released; this page lists the differences.

## New threads start without a project

The sidebar's new thread button and `mod+n` (`chat.new`) start a thread
[without a project](thread-sidebar.md#start-without-a-project). Where your machine offers no
project-free folder, `chat.new` may ask you to choose a project instead. To start in the current
project with your [new-thread defaults](thread-sidebar.md#start-a-thread), Shift+click the button
or press `mod+shift+n` (`chat.newLocal`). `chat.newWithoutProject` (`mod+alt+n`) always starts
without a project.

## Tailscale HTTPS needs HTTPS certificates

[Tailscale HTTPS](remote-access.md#tailscale-https) needs **HTTPS Certificates** turned on for your
tailnet, on the DNS page of the Tailscale admin console. Until then, the route in **Settings →
Connections** says so.

## Thread details sections collapse

In the thread details card, choose a section's title, such as **Automations** or **Lineage**, to
collapse it to its heading, and again to expand it. Each section remembers its state across
threads and restarts. See [Session details](session-details.md#open-them).

## Codex can show hidden models

OpenAI keeps some models out of the Codex picker, such as older or long-context versions. To list
them in the model picker too, turn on **Show hidden models** in the Codex provider's settings,
under **Settings → Providers**. It is off by default, so the picker matches the Codex app.

## Pi model names match the vendor's

Pi's provider groups use brand names, such as **Codex**, **Gemini** and **OpenRouter**, rather
than ids like `openai-codex`. Codex models under Pi are named as OpenAI writes them, such as
**GPT-6.1-Sol**.

A model whose name starts with its group's name and a space, such as **Grok 4.20** under
**Grok**, keeps its full name; T3 Code would show it as **4.20**. A name with punctuation after
the group's name, such as **OpenCode Zen: Step 5**, is still shortened to **Step 5**.
