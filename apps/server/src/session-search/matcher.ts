/**
 * Case-insensitive plain-substring matching for session search, and the
 * snippet cut around a match.
 *
 * @module session-search/matcher
 */
import type { SessionSearchMatchSource, SessionSearchSnippet } from "@t3tools/contracts";

export interface Match {
  readonly index: number;
  readonly length: number;
}

export interface Matcher {
  /**
   * A lowercased piece of the query that the raw bytes of any JSON line
   * holding a match must contain; null when the query has no usable piece.
   */
  readonly needle: string | null;
  readonly find: (text: string) => Match | null;
}

// Printable ASCII that JSON writers never escape. `"` and `\` always are;
// `/`, `<`, `>`, and `&` are by some writers.
const LITERAL_RUN = /[\x20\x21\x23-\x25\x27-\x2e\x30-\x3b\x3d\x3f-\x5b\x5d-\x7e]+/g;
const MIN_NEEDLE = 2;
const SYNTAX_CHARACTERS = /[\\^$.*+?()[\]{}|/]/g;

export const makeMatcher = (query: string): Matcher => {
  let needle: string | null = null;
  for (const [run] of query.matchAll(LITERAL_RUN)) {
    if (run.length >= MIN_NEEDLE && run.length > (needle?.length ?? 0)) needle = run;
  }
  // `iu` folds case one character to one character, so offsets stay in `text`.
  const pattern = new RegExp(query.replace(SYNTAX_CHARACTERS, "\\$&"), "iu");
  return {
    needle: needle?.toLowerCase() ?? null,
    find: (text) => {
      const found = pattern.exec(text);
      return found === null ? null : { index: found.index, length: found[0].length };
    },
  };
};

const SNIPPET_CHARS = 200;
const CONTEXT_BEFORE = 60;

const collapse = (text: string) => text.replace(/\s+/g, " ");
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** About 200 characters of `text` around the match, whitespace collapsed. */
export const cutSnippet = (
  text: string,
  match: Match,
  source: SessionSearchMatchSource,
): SessionSearchSnippet => {
  const matchEnd = match.index + Math.min(match.length, SNIPPET_CHARS);
  const room = SNIPPET_CHARS - (matchEnd - match.index);
  let start = Math.max(0, match.index - Math.min(CONTEXT_BEFORE, Math.floor(room / 2)));
  let end = Math.min(text.length, matchEnd + room - (match.index - start));
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start += 1;
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  const prefix = start > 0 ? "…" : "";
  const before = collapse(text.slice(start, match.index));
  const matched = collapse(text.slice(match.index, matchEnd));
  const after = collapse(text.slice(matchEnd, end));
  const head = prefix + (start === 0 ? before.trimStart() : before);
  const tail = (end === text.length ? after.trimEnd() : after) + (end < text.length ? "…" : "");
  return {
    source,
    text: head + matched + tail,
    matchStart: head.length,
    matchEnd: head.length + matched.length,
  };
};
