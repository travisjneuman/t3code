/**
 * Streams one transcript file in fixed chunks and returns its first user or
 * assistant message that matches. When the store keeps each message whole on
 * one line, only lines whose raw bytes contain the matcher's needle are parsed.
 *
 * @module session-search/scanTranscript
 */
import { Buffer } from "node:buffer";

import type { ExternalSessionMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import type { TranscriptParser } from "../external-sessions/ExternalSessionSource.ts";
import type { Match, Matcher } from "./matcher.ts";
import type { TranscriptLayout } from "./transcriptLayout.ts";

const CHUNK_BYTES = 1024 * 1024;
// Longer lines are tool output in practice, and the parsers clip a message
// to its first 20k characters anyway, so they are skipped unread.
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const NEWLINE = 0x0a;

export interface TranscriptMatch {
  readonly message: ExternalSessionMessage;
  readonly match: Match;
}

export type ScanOutcome = TranscriptMatch | "none" | "timeout";

/**
 * Complete lines in `bytes` (which ends with a newline) that may hold a match.
 * With a needle, only lines containing it; latin1 keeps one character per
 * byte, so offsets in the lowered string are byte offsets.
 */
function* candidateLines(
  bytes: Buffer,
  needle: string | null,
  layout: TranscriptLayout,
): Generator<Buffer> {
  const lowered = bytes.toString("latin1").toLowerCase();
  const wanted = (start: number, end: number) =>
    end - start <= MAX_LINE_BYTES &&
    !layout.skipLine(lowered.slice(start, Math.min(end, start + layout.headChars)));
  if (needle === null) {
    let start = 0;
    for (;;) {
      const end = lowered.indexOf("\n", start);
      if (end === -1) return;
      if (wanted(start, end)) yield bytes.subarray(start, end);
      start = end + 1;
    }
  }
  let hit = lowered.indexOf(needle);
  while (hit !== -1) {
    const start = lowered.lastIndexOf("\n", hit) + 1;
    const end = lowered.indexOf("\n", hit);
    if (end === -1) return;
    if (wanted(start, end)) yield bytes.subarray(start, end);
    hit = lowered.indexOf(needle, end + 1);
  }
}

export const scanTranscript = (
  path: string,
  parser: TranscriptParser,
  matcher: Matcher,
  layout: TranscriptLayout,
  deadline: number,
): Effect.Effect<ScanOutcome, never, FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.open(path, { flag: "r" });
      const chunk = new Uint8Array(CHUNK_BYTES);
      const needle = layout.lineLocal ? matcher.needle : null;
      const state: {
        // A message that may still grow by a later line; checked once complete.
        pending: ExternalSessionMessage | null;
        // The incomplete last line of the previous chunk.
        carry: Buffer | null;
        // Inside a line longer than MAX_LINE_BYTES, until its newline.
        skipping: boolean;
      } = { pending: null, carry: null, skipping: false };

      const test = (message: ExternalSessionMessage): TranscriptMatch | null => {
        if (message.role === "tool") return null;
        const match = matcher.find(message.text);
        return match === null ? null : { message, match };
      };
      const consider = (line: Buffer): TranscriptMatch | null => {
        for (const message of parser.push(line.toString("utf8"))) {
          if (layout.lineLocal) {
            const found = test(message);
            if (found !== null) return found;
            continue;
          }
          if (state.pending !== null && state.pending.id !== message.id) {
            const found = test(state.pending);
            if (found !== null) return found;
          }
          state.pending = message;
        }
        return null;
      };

      for (;;) {
        if (Date.now() > deadline) return "timeout" as const;
        const read = yield* file.read(chunk);
        if (read === 0) break;
        let data = Buffer.from(chunk.buffer, chunk.byteOffset, read);
        if (state.skipping) {
          const newline = data.indexOf(NEWLINE);
          if (newline === -1) continue;
          data = data.subarray(newline + 1);
          state.skipping = false;
        }
        if (state.carry !== null) {
          data = Buffer.concat([state.carry, data]);
          state.carry = null;
        }
        const last = data.lastIndexOf(NEWLINE);
        const rest = data.subarray(last + 1);
        // Copied: `chunk` is reused by the next read.
        if (rest.length > MAX_LINE_BYTES) state.skipping = true;
        else if (rest.length > 0) state.carry = Buffer.from(rest);
        if (last === -1) continue;
        for (const line of candidateLines(data.subarray(0, last + 1), needle, layout)) {
          const found = consider(line);
          if (found !== null) return found;
        }
      }
      // A last line without a newline may still be being written; read it anyway.
      if (state.carry !== null) {
        const tail = Buffer.concat([state.carry, Buffer.from([NEWLINE])]);
        for (const line of candidateLines(tail, needle, layout)) {
          const found = consider(line);
          if (found !== null) return found;
        }
      }
      const result = state.pending === null ? null : test(state.pending);
      return result ?? ("none" as const);
    }),
  ).pipe(Effect.orElseSucceed((): ScanOutcome => "none"));
