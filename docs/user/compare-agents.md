# Compare agents

Compare agents sends one prompt to two models and shows their answers side by side. Use it to see
how different providers, models, or reasoning levels handle the same question.

## Start a comparison

1. Open the command palette and choose **Compare agents…**.
2. Pick the project, write the prompt, and choose a model for each side. The picker next to each
   model sets its options, such as reasoning effort.
3. Choose **Start comparison**.

Each side becomes its own thread, titled `Compare · <model> · <prompt>`, so you can open either one
and keep talking to it. To get back to the side-by-side view from one of these threads, choose
**Open comparison** in the command palette.

Both agents work in the project folder itself, not in separate worktrees. If the prompt asks them
to change files, they edit the same files at the same time. Comparisons work best for questions,
reviews, and plans.

## Review swap

When both agents have finished, **Review swap** sends each one the other's latest answer. The
message says the other agent got the exact same prompt and names its provider, model, and options.
Each agent then says where the two answers differ, what either missed, and gives its best combined
answer. You can run Review swap again after those answers arrive.
