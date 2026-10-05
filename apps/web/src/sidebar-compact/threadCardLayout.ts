/**
 * Layout of the sidebar's full thread cards (active, pinned and working rows,
 * plus unsent new-thread drafts). Sidebar.tsx marks the card with
 * `data-fork-thread-card={THREAD_CARD_LAYOUT}` and its parts with
 * `data-fork-card-part`; `threadCardLayout.css` styles each layout by that
 * value, so the upstream markup and classes stay untouched.
 *
 * "compact" keeps upstream's three lines (project, title, branch) one text
 * size smaller, in a 62px card instead of 78px. Another layout, such as two
 * lines, would add its own value and CSS block here, and can reuse the
 * compact text sizes. Fork add-on: compact sidebar cards.
 */
export const THREAD_CARD_LAYOUT = "compact";

/** Card row height in px, including the row's 4px vertical padding. */
export const THREAD_CARD_ROW_HEIGHT = 66;
