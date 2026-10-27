/**
 * Codex gets the Agents settings block as its own additionalContext entries, so
 * the per-entry cap on `t3_code_runtime` never cuts the user's instructions.
 * Fork add-on: agent instructions.
 */
import {
  FORK_AGENT_INSTRUCTIONS_PREAMBLE,
  FORK_AGENT_INSTRUCTIONS_TAG,
  type ForkAgentScope,
  forkAgentInstructions,
} from "@t3tools/provider-core/server/forkAgentInstructions";

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/** A line over the cap is cut at code points; every other line stays whole. */
function splitLongLine(line: string, maxBytes: number): ReadonlyArray<string> {
  if (byteLength(line) <= maxBytes) return [line];
  const pieces: string[] = [];
  let piece = "";
  let pieceBytes = 0;
  for (const char of line) {
    const charBytes = byteLength(char);
    if (pieceBytes + charBytes > maxBytes) {
      pieces.push(piece);
      piece = "";
      pieceBytes = 0;
    }
    piece += char;
    pieceBytes += charBytes;
  }
  pieces.push(piece);
  return pieces;
}

function splitAtLines(text: string, maxBytes: number): ReadonlyArray<string> {
  const chunks: string[] = [];
  let lines: string[] = [];
  let bytes = 0;
  for (const line of text.split("\n").flatMap((line) => splitLongLine(line, maxBytes))) {
    const lineBytes = byteLength(line);
    if (lines.length > 0 && bytes + 1 + lineBytes > maxBytes) {
      chunks.push(lines.join("\n"));
      lines = [];
      bytes = 0;
    }
    bytes += lines.length === 0 ? lineBytes : 1 + lineBytes;
    lines.push(line);
  }
  if (lines.length > 0) chunks.push(lines.join("\n"));
  return chunks.map((chunk) => chunk.replace(/^\n+|\n+$/g, "")).filter((chunk) => chunk !== "");
}

export function codexForkAgentContext(scope: ForkAgentScope | undefined, maxBytes: number) {
  const text = forkAgentInstructions(scope);
  if (text === "") return {};
  // Numbered like the orchestration sections, because Codex emits entries in key order.
  return Object.fromEntries(
    splitAtLines(`${FORK_AGENT_INSTRUCTIONS_PREAMBLE}\n\n${text}`, maxBytes).map((value, index) => [
      `${FORK_AGENT_INSTRUCTIONS_TAG}_${String(index + 1).padStart(2, "0")}`,
      { kind: "application" as const, value },
    ]),
  );
}
