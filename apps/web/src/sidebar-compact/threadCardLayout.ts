/**
 * Layout of the sidebar's full thread cards (active, pinned and working rows,
 * unsent new-thread drafts, and Other Agents sessions). Each row marks itself
 * with `data-fork-thread-card={THREAD_CARD_LAYOUT}` and its parts with
 * `data-fork-card-part`; `threadCardLayout.css` styles each layout by that
 * value, so the upstream markup and classes stay untouched.
 *
 * "compact" keeps upstream's three lines (project, title, branch) one text
 * size smaller, in an outlined 60px card instead of 78px. Another layout, such
 * as two lines, would add its own value and CSS block here, and can reuse the
 * compact text sizes. Fork add-on: compact sidebar cards.
 */
export const THREAD_CARD_LAYOUT = "compact";

/** Card row height in px, including the row's 3px vertical padding. */
export const THREAD_CARD_ROW_HEIGHT = 63;
