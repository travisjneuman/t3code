/**
 * What every provider's session store adapter provides to ExternalSessions.
 * Adapters only read; they never write to another app's files.
 *
 * @module external-sessions/ExternalSessionSource
 */
import type {
  ExternalSessionDetails,
  ExternalSessionMessage,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

export interface ExternalSessionInfo {
  /** The provider's own session id. */
  readonly id: string;
  readonly title: string;
  readonly cwd: string | null;
  readonly model: string | null;
  readonly origin: string | null;
  readonly updatedAtMs: number;
  /** The provider says a turn is in progress right now. */
  readonly busy: boolean;
  /** Sent only on the session's own stream, never in the list. */
  readonly details: ExternalSessionDetails;
}

type DetailFields = {
  readonly [K in Exclude<keyof ExternalSessionDetails, "sessionId">]?:
    | ExternalSessionDetails[K]
    | null;
};

/** Details without the fields the store did not record, so the wire object stays small. */
export const sessionDetails = (sessionId: string, fields: DetailFields): ExternalSessionDetails => {
  const details: Record<string, unknown> = { sessionId };
  for (const [name, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    details[name] = value;
  }
  return details as ExternalSessionDetails;
};

/** A git branch name; detached checkouts report "HEAD", which names no branch. */
export const branchName = (value: unknown): string | null => {
  const name = typeof value === "string" ? value.trim() : "";
  return name === "" || name === "HEAD" ? null : name;
};

/** Git branches a session ran on, with when each was last used. */
export class BranchHistory {
  private readonly lastUsed = new Map<string, number>();

  add(branch: unknown, atMs: number): void {
    const name = branchName(branch);
    if (name === null) return;
    const previous = this.lastUsed.get(name);
    if (previous === undefined || atMs >= previous) this.lastUsed.set(name, atMs);
  }

  /** Most recently used first. */
  list(): ReadonlyArray<string> {
    return [...this.lastUsed].sort(([, a], [, b]) => b - a).map(([name]) => name);
  }
}

/** Turns transcript lines into messages. A pushed line may grow the last message (same id). */
export interface TranscriptParser {
  readonly push: (line: string) => ReadonlyArray<ExternalSessionMessage>;
}

export interface ExternalSessionSource {
  readonly driver: ProviderDriverKind;
  /** Directories to watch. Missing ones are skipped. */
  readonly roots: ReadonlyArray<{ readonly path: string; readonly recursive: boolean }>;
  /** Session paths a changed file belongs to; empty when the change is irrelevant. */
  readonly sessionPathsFor: (
    changedPath: string,
  ) => Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem>;
  /** Session paths that may have been active since `sinceMs`. */
  readonly discover: (
    sinceMs: number,
  ) => Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem>;
  /**
   * Sessions stored at a path (one for most stores). "hidden" marks a path
   * that never holds a listed session (a subagent, or T3's own), so it is not
   * read again.
   */
  readonly summarize: (
    sessionPath: string,
  ) => Effect.Effect<ReadonlyArray<ExternalSessionInfo> | "hidden", never, FileSystem.FileSystem>;
  /** File whose appended lines carry the session's messages; null when there is none. */
  readonly transcriptPath: (sessionPath: string) => string | null;
  readonly createParser: () => TranscriptParser;
  /**
   * Sessions stay listed until the provider archives them, however old.
   * Without it they age out of the list after two weeks.
   */
  readonly listsUntilArchived?: true;
}

// Tool output and pasted files can be huge; a summary line is enough here.
const MAX_MESSAGE_CHARS = 20_000;
const MAX_TOOL_CHARS = 240;

export const clipMessage = (text: string): string =>
  text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;

export const toolLine = (name: string, detail: string | null | undefined): string => {
  const flat = (detail ?? "").replace(/\s+/g, " ").trim();
  const line = flat === "" ? name : `${name}: ${flat}`;
  return line.length > MAX_TOOL_CHARS ? `${line.slice(0, MAX_TOOL_CHARS)}…` : line;
};

export const firstLine = (text: string, max = 120): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

export const parseJsonObject = (line: string): Record<string, unknown> | null => {
  if (line.length === 0 || line[0] !== "{") return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export const asCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export const timestampMs = (value: unknown, fallback: number): number => {
  // Grok writes epoch seconds; the others write milliseconds or ISO strings.
  if (typeof value === "number" && Number.isFinite(value))
    return value < 1e12 ? value * 1000 : value;
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const isoTimestamp = (value: unknown): string =>
  new Date(timestampMs(value, Date.now())).toISOString();

/** Concatenated `text` of content blocks, or the string itself. */
export const contentText = (content: unknown, textTypes: ReadonlyArray<string>): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: Array<string> = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record === null) continue;
    const type = asString(record.type);
    const text = asString(record.text);
    if (text !== null && (type === null || textTypes.includes(type))) parts.push(text);
  }
  return parts.join("\n\n");
};

export interface FileSlice {
  readonly size: number;
  readonly mtimeMs: number;
  /** Byte offset of `lines[0]`. */
  readonly start: number;
  /** Complete lines only; a partial first line (mid-file start) is dropped. */
  readonly lines: ReadonlyArray<string>;
  /** Byte offset just after the last complete line. */
  readonly end: number;
}

const decoder = new TextDecoder();
const NEWLINE = 0x0a;
const SCAN_CHUNK_BYTES = 1024 * 1024;

/** `length` bytes from `start`, fewer at the end of the file. */
const readRange = (file: FileSystem.File, start: number, length: number) =>
  Effect.gen(function* () {
    yield* file.seek(BigInt(start), "start");
    const buffer = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const read = yield* file.read(buffer.subarray(filled));
      if (read === 0) break;
      filled += read;
    }
    return buffer.subarray(0, filled);
  });

/**
 * Reads complete lines from `[from, min(size, from + maxBytes))`. When
 * `fromEnd` is set, reads the last `maxBytes` instead.
 */
export const readLines = (
  path: string,
  options: { readonly from?: number; readonly fromEnd?: boolean; readonly maxBytes: number },
): Effect.Effect<FileSlice | null, never, FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.open(path, { flag: "r" });
      const info = yield* file.stat;
      const size = Number(info.size);
      const mtimeMs = Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() });
      const start = options.fromEnd
        ? Math.max(0, size - options.maxBytes)
        : Math.min(size, options.from ?? 0);
      const length = Math.min(options.maxBytes, size - start);
      if (length <= 0) return { size, mtimeMs, start, lines: [], end: start };
      const bytes = yield* readRange(file, start, length);
      let first = 0;
      if (start > 0 && options.fromEnd) {
        const newline = bytes.indexOf(NEWLINE);
        first = newline === -1 ? bytes.length : newline + 1;
      }
      const last = bytes.lastIndexOf(NEWLINE);
      if (last < first)
        return { size, mtimeMs, start: start + first, lines: [], end: start + first };
      const lines = decoder
        .decode(bytes.subarray(first, last))
        .split("\n")
        .filter((line) => line.length > 0);
      return { size, mtimeMs, start: start + first, lines, end: start + last + 1 };
    }),
  ).pipe(Effect.orElseSucceed(() => null));

/**
 * Visits the complete lines before byte `before` (a line start), newest first,
 * a chunk at a time, until `visit` returns true or `maxBytes` have been read.
 * A line longer than a chunk is skipped.
 */
export const scanLinesBackward = (
  path: string,
  before: number,
  maxBytes: number,
  visit: (line: string) => boolean,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.open(path, { flag: "r" });
      let end = before;
      // Set when `end` falls inside a skipped line, whose start is no line to visit.
      let insideLine = false;
      while (end > 0 && before - end < maxBytes) {
        const start = Math.max(0, end - SCAN_CHUNK_BYTES);
        const bytes = yield* readRange(file, start, end - start);
        // The line cut at `start` is read whole with the next chunk.
        const from = start === 0 ? 0 : bytes.indexOf(NEWLINE) + 1;
        const to = insideLine ? bytes.lastIndexOf(NEWLINE) + 1 : bytes.length;
        if ((start === 0 || from > 0) && to > from) {
          const lines = decoder.decode(bytes.subarray(from, to)).split("\n");
          for (let index = lines.length - 1; index >= 0; index--) {
            const line = lines[index]!;
            if (line.length > 0 && visit(line)) return;
          }
        }
        if (start === 0) return;
        if (from > 0 && start + from < end) {
          end = start + from;
          insideLine = false;
        } else {
          end = start;
          insideLine = true;
        }
      }
    }),
  ).pipe(Effect.orElseSucceed(() => undefined));

/** The first `maxBytes` of a file as text, whether or not a line ends there. */
export const readPrefix = (
  path: string,
  maxBytes: number,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.open(path, { flag: "r" });
      const buffer = new Uint8Array(maxBytes);
      let filled = 0;
      while (filled < maxBytes) {
        const read = yield* file.read(buffer.subarray(filled));
        if (read === 0) break;
        filled += read;
      }
      return decoder.decode(buffer.subarray(0, filled));
    }),
  ).pipe(Effect.orElseSucceed(() => null));

export const readText = (
  path: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path);
  }).pipe(Effect.orElseSucceed(() => null));

export const statMtimeMs = (
  path: string,
): Effect.Effect<number | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path);
    return Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });
  }).pipe(Effect.orElseSucceed(() => null));

export const listDirectory = (
  path: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readDirectory(path);
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
