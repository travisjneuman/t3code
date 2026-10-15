/**
 * The files an external session's edit and write tools changed, read from
 * its transcript lines for the session details card. Each agent records edits
 * its own way; agents whose transcripts carry no edits T3 can read return
 * null. Line counts come from the patch or the old and new text the agent
 * recorded. Fork add-on; see docs/internals/session-insights.md.
 *
 * @module external-sessions/sessionOutputs
 */
import type { ExternalSessionOutputFile, ProviderDriverKind } from "@t3tools/contracts";

import { asRecord, asString, parseJsonObject } from "./ExternalSessionSource.ts";

/** More files than this is a refactor; the card lists the newest. */
const MAX_FILES = 500;

/** One recorded change to one file; `null` counts when the transcript has none. */
interface FileChange {
  readonly path: string;
  readonly additions: number | null;
  readonly deletions: number | null;
}

/** A change keyed so a later record of the same edit replaces an earlier one. */
interface KeyedChange extends FileChange {
  readonly key: string;
}

const lineCount = (text: string): number => {
  if (text === "") return 0;
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
};

/**
 * Lines added and removed going from `before` to `after`, with the lines both
 * share at the start and end left out. Exact for one contiguous change, which
 * is what a single replacement records.
 */
const textChangeStats = (
  before: string,
  after: string,
): { readonly additions: number; readonly deletions: number } => {
  if (before === "") return { additions: lineCount(after), deletions: 0 };
  const left = before.split("\n");
  const right = after.split("\n");
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  return { additions: rightEnd - start, deletions: leftEnd - start };
};

// Claude Code: a tool result's `toolUseResult` names the file and carries the
// patch it applied, or the content of a file it created.
const claudeChanges = (record: Record<string, unknown>): ReadonlyArray<KeyedChange> => {
  if (record.type !== "user") return [];
  const result = asRecord(record.toolUseResult);
  const path = asString(result?.filePath);
  if (result === null || path === null) return [];
  const key = asString(record.uuid) ?? path;
  if (result.type === "create") {
    const content = asString(result.content) ?? "";
    return [{ key, path, additions: lineCount(content), deletions: 0 }];
  }
  // Only edits and writes carry a patch; an unchanged write carries an empty one.
  if (!Array.isArray(result.structuredPatch) || result.structuredPatch.length === 0) return [];
  let additions = 0;
  let deletions = 0;
  for (const hunk of result.structuredPatch) {
    const lines = asRecord(hunk)?.lines;
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  return [{ key, path, additions, deletions }];
};

const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE = /^\*\*\* Move to: (.+)$/;

/** The files an `apply_patch` envelope changes, counted from its +/- lines. */
const patchChanges = (patch: string, key: string): ReadonlyArray<KeyedChange> => {
  const out: Array<KeyedChange> = [];
  let current: { path: string; additions: number; deletions: number } | null = null;
  const flush = () => {
    if (current !== null) out.push({ key: `${key}:${current.path}`, ...current });
    current = null;
  };
  for (const line of patch.split("\n")) {
    const file = PATCH_FILE.exec(line);
    if (file !== null) {
      flush();
      current = { path: file[2]!.trim(), additions: 0, deletions: 0 };
      continue;
    }
    if (current === null) continue;
    const move = PATCH_MOVE.exec(line);
    if (move !== null) {
      current.path = move[1]!.trim();
      continue;
    }
    if (line.startsWith("***") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) current.additions += 1;
    else if (line.startsWith("-")) current.deletions += 1;
  }
  flush();
  return out;
};

const PATCH_START = "*** Begin Patch";

// Codex: `apply_patch` calls carry the patch as their input, and a shell call
// can pipe one in; either way the envelope names each file.
const codexChanges = (record: Record<string, unknown>): ReadonlyArray<KeyedChange> => {
  const payload = asRecord(record.payload);
  if (record.type !== "response_item" || payload === null) return [];
  if (payload.type !== "function_call" && payload.type !== "custom_tool_call") return [];
  const key = asString(payload.call_id) ?? asString(payload.id) ?? "";
  const candidates: Array<string> = [];
  const input = asString(payload.input);
  if (input !== null) candidates.push(input);
  const args = parseJsonObject(asString(payload.arguments) ?? "");
  if (args !== null) {
    for (const value of [args.input, args.patch, args.cmd, args.command]) {
      if (typeof value === "string") candidates.push(value);
      else if (Array.isArray(value))
        candidates.push(value.filter((part) => typeof part === "string").join("\n"));
    }
  }
  const patch = candidates.find((text) => text.includes(PATCH_START));
  return patch === undefined ? [] : patchChanges(patch, key);
};

// Pi: assistant tool calls name the file; `edit` carries each replacement and
// `write` the whole content, which may overwrite a file it never read.
const piChanges = (record: Record<string, unknown>): ReadonlyArray<KeyedChange> => {
  const message = asRecord(record.message);
  if (record.type !== "message" || message?.role !== "assistant") return [];
  if (!Array.isArray(message.content)) return [];
  const out: Array<KeyedChange> = [];
  for (const block of message.content) {
    const call = asRecord(block);
    if (call?.type !== "toolCall") continue;
    const name = asString(call.name);
    const args = asRecord(call.arguments);
    const path = asString(args?.path);
    if (path === null || (name !== "edit" && name !== "write")) continue;
    const key = asString(call.id) ?? path;
    if (name === "write") {
      out.push({ key, path, additions: null, deletions: null });
      continue;
    }
    let additions = 0;
    let deletions = 0;
    const edits = Array.isArray(args?.edits) ? args.edits : [];
    for (const edit of edits) {
      const value = asRecord(edit);
      const stats = textChangeStats(asString(value?.oldText) ?? "", asString(value?.newText) ?? "");
      additions += stats.additions;
      deletions += stats.deletions;
    }
    out.push({ key, path, additions, deletions });
  }
  return out;
};

// Grok (ACP updates): a tool call's update carries a diff per file with the
// old and new text. The same diff is sent again when the call completes, so
// the key keeps one per call and file.
const grokChanges = (record: Record<string, unknown>): ReadonlyArray<KeyedChange> => {
  const update = asRecord(asRecord(record.params)?.update);
  if (update?.sessionUpdate !== "tool_call_update" || !Array.isArray(update.content)) return [];
  const callId = asString(update.toolCallId) ?? "";
  const out: Array<KeyedChange> = [];
  for (const item of update.content) {
    const diff = asRecord(item);
    const path = asString(diff?.path);
    if (diff?.type !== "diff" || path === null) continue;
    const stats = textChangeStats(asString(diff.oldText) ?? "", asString(diff.newText) ?? "");
    out.push({ key: `${callId}:${path}`, path, ...stats });
  }
  return out;
};

interface Reader {
  /** Text every line this reader uses contains, so other lines skip parsing. */
  readonly hint: string;
  readonly read: (record: Record<string, unknown>) => ReadonlyArray<KeyedChange>;
}

const READERS: Partial<Record<string, Reader>> = {
  claudeAgent: { hint: '"toolUseResult"', read: claudeChanges },
  codex: { hint: PATCH_START, read: codexChanges },
  pi: { hint: '"toolCall"', read: piChanges },
  grok: { hint: '"diff"', read: grokChanges },
};

/** Whether this agent's transcript records edits T3 can read. */
export const readsSessionOutputs = (driver: ProviderDriverKind): boolean =>
  READERS[driver] !== undefined;

/**
 * Unique files changed, newest first, with line counts summed across edits.
 * Null for an agent whose transcript records no edits T3 can read.
 */
export const sessionOutputs = (
  driver: ProviderDriverKind,
  lines: ReadonlyArray<string>,
): ReadonlyArray<ExternalSessionOutputFile> | null => {
  const reader = READERS[driver];
  if (reader === undefined) return null;
  // Later records of one edit replace earlier ones; Map order stays the first sighting.
  const changes = new Map<string, FileChange>();
  for (const line of lines) {
    if (!line.includes(reader.hint)) continue;
    const record = parseJsonObject(line);
    if (record === null) continue;
    for (const change of reader.read(record)) {
      changes.delete(change.key);
      changes.set(change.key, change);
    }
  }
  const byPath = new Map<
    string,
    { path: string; additions: number; deletions: number; hasStats: boolean }
  >();
  const ordered = [...changes.values()];
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const change = ordered[index]!;
    let entry = byPath.get(change.path);
    if (entry === undefined) {
      if (byPath.size >= MAX_FILES) continue;
      entry = { path: change.path, additions: 0, deletions: 0, hasStats: false };
      byPath.set(change.path, entry);
    }
    if (change.additions !== null && change.deletions !== null) {
      entry.additions += change.additions;
      entry.deletions += change.deletions;
      entry.hasStats = true;
    }
  }
  return [...byPath.values()];
};
