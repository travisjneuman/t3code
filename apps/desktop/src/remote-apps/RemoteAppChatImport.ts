/**
 * Turns an official chat export into a folder of Markdown files, one per
 * conversation plus an index.
 *
 * Terms-of-service basis: only account data exports the user requested from
 * the provider themselves (ChatGPT and Claude "Export data", Open WebUI's chat
 * export) and picked from disk. Parsing is local; nothing touches the network
 * or a site's pages.
 */
import type { RemoteAppChatImportResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Electron from "electron";

import { claimUniqueFilename, safeFilename } from "./RemoteAppFiles.ts";

const MAX_EXPORT_BYTES = 500 * 1024 * 1024;
const EXPORT_FILENAME = "conversations.json";
const UNRECOGNIZED_MESSAGE =
  "Not a recognized chat export. Supported: ChatGPT and Claude account exports (conversations.json) and Open WebUI chat exports (.json).";

type ChatSource = "ChatGPT" | "Claude" | "Open WebUI";

interface ChatTurn {
  readonly role: "User" | "Assistant";
  readonly text: string;
}

interface ChatConversation {
  readonly title: string;
  readonly createdAt: Date | null;
  readonly turns: ReadonlyArray<ChatTurn>;
}

interface ChatExport {
  readonly source: ChatSource;
  readonly conversations: ReadonlyArray<ChatConversation>;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

/** Epoch nanoseconds, microseconds, milliseconds or seconds, by magnitude. */
const epochMillis = (value: number): number => {
  if (value > 1e17) return value / 1e6;
  if (value > 1e14) return value / 1e3;
  return value > 1e11 ? value : value * 1e3;
};

/** An epoch number in any common unit, or an ISO string. */
const parseDate = (value: unknown): Date | null => {
  let date: Date | null = null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    date = new Date(epochMillis(value));
  } else if (typeof value === "string" && value.trim().length > 0) {
    date = new Date(value);
  }
  return date !== null && Number.isFinite(date.getTime()) ? date : null;
};

const roleOf = (value: unknown): ChatTurn["role"] | null => {
  if (value === "user" || value === "human") return "User";
  return value === "assistant" ? "Assistant" : null;
};

const titleOf = (value: unknown): string => {
  const title = (asString(value) ?? "").replace(/\s+/g, " ").trim();
  return title.length > 0 ? title : "Untitled";
};

const joinText = (pieces: ReadonlyArray<string>): string =>
  pieces
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .join("\n\n");

/** A string, or an array of strings and `{ type: "text", text }` blocks. */
const contentText = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  return joinText(
    asArray(value).map((item) => {
      if (typeof item === "string") return item;
      if (!isRecord(item)) return "";
      return item.type === undefined || item.type === "text" ? (asString(item.text) ?? "") : "";
    }),
  );
};

// ChatGPT: a message tree in `mapping`; the shown branch runs from
// `current_node` up through `parent`. Tool calls, hidden context, and
// reasoning are left out; only text the user and assistant exchanged stays.
const CHATGPT_TEXT_CONTENT = new Set(["text", "multimodal_text"]);

const chatGptPartText = (part: unknown): string => {
  if (typeof part === "string") return part;
  if (!isRecord(part)) return "";
  const text = asString(part.text);
  if (text !== undefined) return text;
  return asString(part.content_type)?.includes("image") ? "[image]" : "";
};

const chatGptTurn = (node: unknown): ChatTurn | null => {
  const message = isRecord(node) ? node.message : undefined;
  if (!isRecord(message)) return null;
  const role = roleOf(isRecord(message.author) ? message.author.role : undefined);
  const recipient = asString(message.recipient);
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  const content = isRecord(message.content) ? message.content : {};
  if (role === null || (recipient !== undefined && recipient !== "all")) return null;
  if (metadata.is_visually_hidden_from_conversation === true) return null;
  if (!CHATGPT_TEXT_CONTENT.has(asString(content.content_type) ?? "")) return null;
  const text = joinText(asArray(content.parts).map(chatGptPartText));
  return text.length > 0 ? { role, text } : null;
};

/** The newest leaf, for an export without `current_node`. */
const latestChatGptLeaf = (mapping: JsonRecord): string | undefined => {
  let latest: { readonly id: string; readonly time: number } | undefined;
  for (const [id, node] of Object.entries(mapping)) {
    if (!isRecord(node) || asArray(node.children).length > 0) continue;
    const time = isRecord(node.message) ? (parseDate(node.message.create_time)?.getTime() ?? 0) : 0;
    if (latest === undefined || time >= latest.time) latest = { id, time };
  }
  return latest?.id;
};

const chatGptConversation = (item: JsonRecord): ChatConversation => {
  const mapping = isRecord(item.mapping) ? item.mapping : {};
  const branch: unknown[] = [];
  const visited = new Set<string>();
  let id = asString(item.current_node) ?? latestChatGptLeaf(mapping);
  while (id !== undefined && !visited.has(id) && isRecord(mapping[id])) {
    visited.add(id);
    const node = mapping[id];
    branch.push(node);
    id = isRecord(node) ? asString(node.parent) : undefined;
  }
  return {
    title: titleOf(item.title),
    createdAt: parseDate(item.create_time),
    turns: branch.toReversed().flatMap((node) => chatGptTurn(node) ?? []),
  };
};

// Claude: a flat `chat_messages` list; text lives in `content` blocks, or in
// `text` in older exports.
const claudeConversation = (item: JsonRecord): ChatConversation => ({
  title: titleOf(item.name),
  createdAt: parseDate(item.created_at),
  turns: asArray(item.chat_messages).flatMap((message) => {
    if (!isRecord(message)) return [];
    const role = roleOf(message.sender);
    const text = contentText(message.content) || contentText(message.text);
    return role !== null && text.length > 0 ? [{ role, text }] : [];
  }),
});

// Open WebUI: `chat.history` is a tree walked from `currentId` through
// `parentId`; `chat.messages` is the flat fallback.
const openWebUiMessages = (chat: JsonRecord): ReadonlyArray<unknown> => {
  const history = isRecord(chat.history) ? chat.history : {};
  const messages = isRecord(history.messages) ? history.messages : {};
  const branch: unknown[] = [];
  const visited = new Set<string>();
  let id = asString(history.currentId);
  while (id !== undefined && !visited.has(id) && isRecord(messages[id])) {
    visited.add(id);
    const message = messages[id];
    branch.push(message);
    id = isRecord(message) ? asString(message.parentId) : undefined;
  }
  return branch.length > 0 ? branch.toReversed() : asArray(chat.messages);
};

const openWebUiConversation = (item: JsonRecord): ChatConversation => {
  const chat = isRecord(item.chat) ? item.chat : {};
  return {
    title: titleOf(asString(item.title) ?? chat.title),
    createdAt: parseDate(item.created_at ?? chat.timestamp),
    turns: openWebUiMessages(chat).flatMap((message) => {
      if (!isRecord(message)) return [];
      const role = roleOf(message.role);
      const text = contentText(message.content);
      return role !== null && text.length > 0 ? [{ role, text }] : [];
    }),
  };
};

const FORMATS: ReadonlyArray<{
  readonly source: ChatSource;
  readonly matches: (item: JsonRecord) => boolean;
  readonly parse: (item: JsonRecord) => ChatConversation;
}> = [
  { source: "ChatGPT", matches: (item) => isRecord(item.mapping), parse: chatGptConversation },
  {
    source: "Claude",
    matches: (item) => Array.isArray(item.chat_messages),
    parse: claudeConversation,
  },
  { source: "Open WebUI", matches: (item) => isRecord(item.chat), parse: openWebUiConversation },
];

/**
 * Recognizes an export by its shape, not its filename. Null when no item
 * matches a supported format; conversations without any text are dropped.
 */
export const parseChatExport = (value: unknown): ChatExport | null => {
  const items = (Array.isArray(value) ? value : [value]).filter(isRecord);
  const first = items.find((item) => FORMATS.some((format) => format.matches(item)));
  const format = first && FORMATS.find((candidate) => candidate.matches(first));
  if (format === undefined) return null;
  return {
    source: format.source,
    conversations: items
      .filter(format.matches)
      .map(format.parse)
      .filter((conversation) => conversation.turns.length > 0),
  };
};

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const renderConversation = (conversation: ChatConversation, source: ChatSource): string => {
  const date = conversation.createdAt === null ? "" : `Date: ${isoDay(conversation.createdAt)} · `;
  const turns = conversation.turns.map((turn) => `## ${turn.role}\n\n${turn.text}`);
  return `# ${conversation.title}\n\n${date}Source: ${source}\n\n${turns.join("\n\n")}\n`;
};

const linkLabel = (title: string): string => title.replace(/[[\]\\]/g, "\\$&");

interface WrittenConversation {
  readonly conversation: ChatConversation;
  readonly filename: string;
}

const renderIndex = (
  source: ChatSource,
  written: ReadonlyArray<WrittenConversation>,
  today: string,
): string => {
  const lines = written.map(({ conversation, filename }) => {
    const date = conversation.createdAt === null ? "" : `${isoDay(conversation.createdAt)} `;
    return `- ${date}[${linkLabel(conversation.title)}](<${filename}>)`;
  });
  const count = `${written.length} conversation${written.length === 1 ? "" : "s"}`;
  return `# ${source} export\n\nImported ${count} on ${today}.\n\n${lines.join("\n")}\n`;
};

/** Newest first, so the index reads like the site's own history. */
const byNewest = (left: ChatConversation, right: ChatConversation): number =>
  (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0);

const showOpenDialog = (
  owner: Electron.BrowserWindow | undefined,
  options: Electron.OpenDialogOptions,
) =>
  Effect.tryPromise(() =>
    owner === undefined || owner.isDestroyed()
      ? Electron.dialog.showOpenDialog(options)
      : Electron.dialog.showOpenDialog(owner, options),
  ).pipe(Effect.map((result) => (result.canceled ? undefined : result.filePaths[0])));

class ChatImportFailure {
  readonly _tag = "ChatImportFailure";
  constructor(readonly message: string) {}
}

const fail = (message: string) => Effect.fail(new ChatImportFailure(message));

/** The export file the user picked, or `conversations.json` inside a picked folder. */
const resolveExportFile = (picked: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pickedInfo = yield* fileSystem.stat(picked);
    const file = pickedInfo.type === "Directory" ? path.join(picked, EXPORT_FILENAME) : picked;
    if (file !== picked && !(yield* fileSystem.exists(file))) {
      return yield* fail(`That folder has no ${EXPORT_FILENAME}. ${UNRECOGNIZED_MESSAGE}`);
    }
    const info = file === picked ? pickedInfo : yield* fileSystem.stat(file);
    if (info.type !== "File") return yield* fail(UNRECOGNIZED_MESSAGE);
    if (Number(info.size) > MAX_EXPORT_BYTES) {
      return yield* fail("That export is larger than 500 MB, which is more than T3 imports.");
    }
    return file;
  });

const readExport = (file: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fileSystem.readFileString(file, "utf8");
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(raw),
      catch: () => new ChatImportFailure(`${path.basename(file)} is not valid JSON.`),
    });
    const parsed = parseChatExport(json);
    if (parsed === null) return yield* fail(UNRECOGNIZED_MESSAGE);
    if (parsed.conversations.length === 0) {
      return yield* fail(`That ${parsed.source} export has no conversations with text.`);
    }
    return parsed;
  });

/** A new folder inside `parent`, numbered when the name is taken. */
const makeOutputFolder = (parent: string, name: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (let index = 1; index <= 100; index += 1) {
      const folder = path.join(parent, index === 1 ? name : `${name} (${index})`);
      if (yield* fileSystem.exists(folder)) continue;
      yield* fileSystem.makeDirectory(folder);
      return folder;
    }
    return yield* fail(`Couldn't create a new folder in ${parent}.`);
  });

const writeExport = (folder: string, parsed: ChatExport, today: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const taken = new Set(["index.md"]);
    const written: WrittenConversation[] = [];
    for (const conversation of parsed.conversations.toSorted(byNewest)) {
      const date = conversation.createdAt === null ? "" : `${isoDay(conversation.createdAt)} `;
      const stem = safeFilename(`${date}${conversation.title}`.slice(0, 120), "Untitled");
      const filename = claimUniqueFilename(stem, ".md", taken);
      yield* fileSystem.writeFileString(
        path.join(folder, filename),
        renderConversation(conversation, parsed.source),
        { flag: "wx" },
      );
      written.push({ conversation, filename });
    }
    const index = path.join(folder, "index.md");
    yield* fileSystem.writeFileString(index, renderIndex(parsed.source, written, today), {
      flag: "wx",
    });
    return index;
  });

/**
 * Asks for an export file (or, on macOS, an extracted export folder), parses it
 * in this process, asks where to put the Markdown, writes it into a new folder
 * there, and reveals the index. Never touches the network.
 */
export const importRemoteAppChatExport = (
  owner: Electron.BrowserWindow | undefined,
  platform: NodeJS.Platform,
) =>
  Effect.gen(function* () {
    const picked = yield* showOpenDialog(owner, {
      title: "Import Chat Export",
      buttonLabel: "Import",
      message:
        "Choose conversations.json from a ChatGPT or Claude export, or an Open WebUI export.",
      properties: platform === "darwin" ? ["openFile", "openDirectory"] : ["openFile"],
      filters: [{ name: "Chat export", extensions: ["json"] }],
    });
    if (picked === undefined) return { status: "canceled" } satisfies RemoteAppChatImportResult;
    const parsed = yield* readExport(yield* resolveExportFile(picked));

    const destination = yield* showOpenDialog(owner, {
      title: "Save Markdown Files",
      buttonLabel: "Save Here",
      message: "T3 creates a new folder here with one Markdown file per conversation.",
      properties: ["openDirectory", "createDirectory"],
    });
    if (destination === undefined) {
      return { status: "canceled" } satisfies RemoteAppChatImportResult;
    }
    const today = isoDay(new Date());
    const folder = yield* makeOutputFolder(destination, `${parsed.source} export ${today}`);
    const index = yield* writeExport(folder, parsed, today);
    Electron.shell.showItemInFolder(index);
    return {
      status: "imported",
      source: parsed.source,
      conversations: parsed.conversations.length,
      folder,
    } satisfies RemoteAppChatImportResult;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        status: "failed",
        message:
          error instanceof ChatImportFailure
            ? error.message.slice(0, 1_000)
            : "Couldn't import that export. Check that the file is readable and the folder is writable.",
      } satisfies RemoteAppChatImportResult),
    ),
  );
