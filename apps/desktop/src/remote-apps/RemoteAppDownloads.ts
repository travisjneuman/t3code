/**
 * Offers a web app's downloaded text files and archives to T3 once saved.
 *
 * Terms-of-service basis: only files the site itself offers for download,
 * after the user's own click and their choice in the native save dialog. The
 * shell reads the saved copy from disk; it never fetches from the site.
 */
import {
  REMOTE_APP_DOWNLOAD_TEXT_MAX_BYTES,
  type RemoteAppDownloadCapture,
  type RemoteAppSite,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Extensions whose fence language differs from the extension itself.
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  txt: "",
  text: "",
  log: "",
  yml: "yaml",
  htm: "html",
  jsonl: "json",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  sh: "bash",
  zsh: "bash",
  ps1: "powershell",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  pl: "perl",
  tf: "hcl",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  gql: "graphql",
};

const TEXT_EXTENSIONS = new Set([
  ...Object.keys(LANGUAGE_BY_EXTENSION),
  "json",
  "csv",
  "tsv",
  "yaml",
  "toml",
  "ini",
  "html",
  "xml",
  "css",
  "scss",
  "less",
  "jsx",
  "tsx",
  "vue",
  "svelte",
  "go",
  "java",
  "swift",
  "c",
  "cpp",
  "php",
  "bash",
  "sql",
  "lua",
  "r",
  "dart",
  "scala",
  "graphql",
  "proto",
  "diff",
  "patch",
  "tex",
  "rst",
  "org",
  "adoc",
]);

const ARCHIVE_EXTENSIONS = new Set(["zip"]);

export interface RemoteAppDownloadKind {
  readonly kind: RemoteAppDownloadCapture["kind"];
  readonly language: string;
}

/** Whether T3 offers this saved download, and how; null for any other file. */
export const classifyRemoteAppDownload = (filename: string): RemoteAppDownloadKind | null => {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = filename.slice(dot + 1).toLowerCase();
  if (ARCHIVE_EXTENSIONS.has(extension)) return { kind: "archive", language: "" };
  if (!TEXT_EXTENSIONS.has(extension)) return null;
  return { kind: "text", language: LANGUAGE_BY_EXTENSION[extension] ?? extension };
};

/**
 * Describes a saved download for T3, reading a text file's contents only when
 * it fits the cap. Null when the file is not one T3 offers, is blank, is gone,
 * or turns out to be binary.
 */
export const readRemoteAppDownloadCapture = (input: {
  readonly id: string;
  readonly site: RemoteAppSite;
  readonly filePath: string;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filename = path.basename(input.filePath);
    const kind = classifyRemoteAppDownload(filename);
    if (kind === null) return null;
    const info = yield* fileSystem.stat(input.filePath);
    const bytes = Number(info.size);
    if (info.type !== "File" || bytes === 0) return null;
    const readable = kind.kind === "text" && bytes <= REMOTE_APP_DOWNLOAD_TEXT_MAX_BYTES;
    const text = readable ? yield* fileSystem.readFileString(input.filePath, "utf8") : null;
    if (text !== null && (text.includes("\u0000") || text.trim().length === 0)) return null;
    return {
      id: input.id,
      site: input.site,
      filename: filename.slice(0, 255),
      path: input.filePath,
      kind: kind.kind,
      bytes,
      language: kind.language,
      text,
      addNow: false,
    } satisfies RemoteAppDownloadCapture;
  }).pipe(Effect.catch(() => Effect.succeed(null)));
