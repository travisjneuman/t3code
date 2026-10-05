/**
 * What session search assumes about each store's transcript lines, beyond
 * what its parser already says. Unknown drivers get the safe default: every
 * line parsed, none skipped.
 *
 * @module session-search/transcriptLayout
 */
import type { ProviderDriverKind } from "@t3tools/contracts";

export interface TranscriptLayout {
  /**
   * Every message is whole on one line, so a line whose raw bytes lack the
   * query cannot match. Grok streams a reply as many chunk lines instead.
   */
  readonly lineLocal: boolean;
  /** Characters of a line's lowered head that `skipLine` looks at. */
  readonly headChars: number;
  /** Lines that never carry a user or assistant message, judged by their head. */
  readonly skipLine: (loweredHead: string) => boolean;
}

// Codex rollouts are mostly tool output, reasoning, and compaction copies
// (gigabytes on a busy machine); its parser reads only `response_item`
// messages. Both type fields sit in the first ~90 bytes of a line. A list
// of known bulk types fails safe if the format adds new ones.
const CODEX_BULK_TYPES = [
  '"type":"event_msg"',
  '"type":"compacted"',
  '"type":"world_state"',
  '"type":"token_usage_record"',
  '"type":"reasoning"',
  '"type":"function_call"',
  '"type":"function_call_output"',
  '"type":"custom_tool_call"',
  '"type":"custom_tool_call_output"',
];

const keepAll = () => false;

export const transcriptLayout = (driver: ProviderDriverKind): TranscriptLayout => {
  switch (driver) {
    case "codex":
      return {
        lineLocal: true,
        headChars: 160,
        skipLine: (head) => CODEX_BULK_TYPES.some((type) => head.includes(type)),
      };
    case "claudeAgent":
    case "pi":
      return { lineLocal: true, headChars: 0, skipLine: keepAll };
    default:
      return { lineLocal: false, headChars: 0, skipLine: keepAll };
  }
};
