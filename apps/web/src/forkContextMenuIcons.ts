/**
 * Fork add-on icons for the browser context-menu fallback, in the same inline
 * Lucide format as its built-in icons (stroke-based, viewBox 0 0 24 24).
 */
export const FORK_CONTEXT_MENU_ICON_PATHS: Record<
  string,
  ReadonlyArray<{ tag: string; attrs: Record<string, string> }>
> = {
  // External-session hand back.
  "undo-2": [
    { tag: "path", attrs: { d: "M9 14 4 9l5-5" } },
    { tag: "path", attrs: { d: "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" } },
  ],
  // Thread export.
  download: [
    { tag: "path", attrs: { d: "M12 15V3" } },
    { tag: "path", attrs: { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" } },
    { tag: "path", attrs: { d: "m7 10 5 5 5-5" } },
  ],
};
