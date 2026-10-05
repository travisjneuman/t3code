/**
 * Turns the selection tree from buildRemoteAppSelectionScript into Markdown:
 * headings, paragraphs, emphasis, inline and fenced code, links, nested
 * lists, quotes, tables, rules, and TeX math. Text is not Markdown-escaped, so
 * a reply's literal asterisks stay as written.
 */
import { remoteAppMarkdownFence } from "@t3tools/contracts";

export interface RemoteAppSelectionElement {
  readonly tag: string;
  readonly children: ReadonlyArray<RemoteAppSelectionNode>;
  readonly href?: string;
  readonly lang?: string;
  readonly alt?: string;
  readonly start?: number;
  readonly tex?: string;
  readonly display?: boolean;
}

export type RemoteAppSelectionNode = string | RemoteAppSelectionElement;

// The page caps its walk at 64 levels; anything deeper is not from that script.
const MAX_DEPTH = 80;

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

const decodeNode = (value: unknown, depth: number): RemoteAppSelectionNode | null => {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || depth > MAX_DEPTH) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.tag !== "string" || !Array.isArray(record.children)) return null;
  const text = (key: string): string | undefined => {
    const field = record[key];
    return typeof field === "string" ? field : undefined;
  };
  const start = record.start;
  return {
    tag: record.tag.toLowerCase(),
    children: decodeChildren(record.children, depth + 1),
    ...optional("href", text("href")),
    ...optional("lang", text("lang")),
    ...optional("alt", text("alt")),
    ...optional("tex", text("tex")),
    ...optional("start", typeof start === "number" && Number.isInteger(start) ? start : undefined),
    ...optional("display", record.display === true ? true : undefined),
  };
};

const decodeChildren = (
  values: ReadonlyArray<unknown>,
  depth: number,
): ReadonlyArray<RemoteAppSelectionNode> =>
  values.flatMap((value) => {
    const node = decodeNode(value, depth);
    return node === null ? [] : [node];
  });

/** Validates the page script's untrusted result; null when it is not a selection tree. */
export const decodeRemoteAppSelection = (
  value: unknown,
): ReadonlyArray<RemoteAppSelectionNode> | null =>
  Array.isArray(value) ? decodeChildren(value, 0) : null;

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);

const TABLE_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);

const isBlock = (node: RemoteAppSelectionNode): node is RemoteAppSelectionElement =>
  typeof node !== "string" &&
  (BLOCK_TAGS.has(node.tag) || (node.tag === "math" && node.display === true));

const textOf = (node: RemoteAppSelectionNode): string => {
  if (typeof node === "string") return node;
  return node.tag === "math" ? (node.tex ?? "") : node.children.map(textOf).join("");
};

const findFirst = (
  node: RemoteAppSelectionElement,
  tag: string,
): RemoteAppSelectionElement | undefined => {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (child.tag === tag) return child;
    const found = findFirst(child, tag);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** Keeps surrounding spaces outside the markers, so "a **b** c" never becomes "a** b **c". */
const wrapInline = (marker: string, inner: string): string => {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (match === null || match[2] === undefined || match[2].length === 0) return inner;
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
};

const inlineCode = (text: string): string => {
  const code = text.replace(/\s*\n\s*/g, " ");
  if (code.trim().length === 0) return code;
  let longest = 0;
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const ticks = "`".repeat(longest + 1);
  const padding = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${ticks}${padding}${code}${padding}${ticks}`;
};

const SAFE_LINK = /^(https?:|mailto:)/i;

const renderInlineNode = (node: RemoteAppSelectionNode): string => {
  if (typeof node === "string") return node.replace(/\s+/g, " ");
  const inner = () => renderInline(node.children);
  switch (node.tag) {
    case "br":
      return "\n";
    case "strong":
    case "b":
      return wrapInline("**", inner());
    case "em":
    case "i":
      return wrapInline("*", inner());
    case "del":
    case "s":
    case "strike":
      return wrapInline("~~", inner());
    case "code":
    case "kbd":
    case "samp":
      return inlineCode(textOf(node));
    case "img":
      return node.alt ?? "";
    case "math":
      return node.tex ? `$${node.tex}$` : "";
    case "a": {
      const label = inner();
      const href = node.href;
      if (href === undefined || !SAFE_LINK.test(href)) return label;
      return label.trim().length === 0 ? `<${href}>` : `[${label.trim()}](<${href}>)`;
    }
    default:
      return inner();
  }
};

const renderInline = (nodes: ReadonlyArray<RemoteAppSelectionNode>): string =>
  nodes.map(renderInlineNode).join("");

const singleLine = (nodes: ReadonlyArray<RemoteAppSelectionNode>): string =>
  renderInline(nodes)
    .replace(/\s*\n\s*/g, " ")
    .trim();

const indentContinuation = (content: string, marker: string): string =>
  content
    .split("\n")
    .map((line, index) => {
      if (index === 0) return `${marker}${line}`;
      return line.length > 0 ? `${" ".repeat(marker.length)}${line}` : "";
    })
    .join("\n");

const renderList = (list: RemoteAppSelectionElement): string => {
  const ordered = list.tag === "ol";
  let number = list.start ?? 1;
  const items: string[] = [];
  for (const child of list.children) {
    if (typeof child === "string" && child.trim().length === 0) continue;
    const content = renderBlocks(
      typeof child !== "string" && child.tag === "li" ? child.children : [child],
    ).join("\n");
    if (content.length === 0) continue;
    items.push(indentContinuation(content, ordered ? `${number}. ` : "- "));
    number += 1;
  }
  return items.join("\n");
};

const collectRows = (
  node: RemoteAppSelectionElement,
  rows: RemoteAppSelectionElement[],
): RemoteAppSelectionElement[] => {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (child.tag === "tr") rows.push(child);
    else if (TABLE_TAGS.has(child.tag)) collectRows(child, rows);
  }
  return rows;
};

const renderTable = (table: RemoteAppSelectionElement): string => {
  const rows = (table.tag === "tr" ? [table] : collectRows(table, [])).map((row) =>
    row.children
      .filter(
        (cell): cell is RemoteAppSelectionElement =>
          typeof cell !== "string" && (cell.tag === "td" || cell.tag === "th"),
      )
      .map((cell) => singleLine(cell.children).replace(/\|/g, "\\|")),
  );
  const width = Math.max(0, ...rows.map((cells) => cells.length));
  if (width === 0) return renderBlocks(table.children).join("\n\n");
  const line = (cells: ReadonlyArray<string>) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  const [header = [], ...body] = rows;
  return [line(header), line(Array.from({ length: width }, () => "---")), ...body.map(line)].join(
    "\n",
  );
};

const renderCodeBlock = (pre: RemoteAppSelectionElement): string => {
  const code = findFirst(pre, "code");
  const text = textOf(code ?? pre).replace(/\n$/, "");
  const fence = remoteAppMarkdownFence(text);
  return `${fence}${pre.lang ?? code?.lang ?? ""}\n${text}\n${fence}`;
};

const renderBlock = (node: RemoteAppSelectionElement): string => {
  const heading = /^h([1-6])$/.exec(node.tag);
  if (heading !== null) {
    const text = singleLine(node.children);
    return text.length === 0 ? "" : `${"#".repeat(Number(heading[1]))} ${text}`;
  }
  switch (node.tag) {
    case "hr":
      return "---";
    case "pre":
      return renderCodeBlock(node);
    case "ul":
    case "ol":
      return renderList(node);
    // A selection inside one list keeps its items even without the list.
    case "li":
      return renderList({ tag: "ul", children: [node] });
    case "blockquote":
      return renderBlocks(node.children)
        .join("\n\n")
        .split("\n")
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n");
    case "math":
      return node.tex ? `$$\n${node.tex}\n$$` : "";
    default:
      return TABLE_TAGS.has(node.tag)
        ? renderTable(node)
        : renderBlocks(node.children).join("\n\n");
  }
};

/** Block-level Markdown for a run of nodes; inline runs between blocks become paragraphs. */
const renderBlocks = (nodes: ReadonlyArray<RemoteAppSelectionNode>): string[] => {
  const blocks: string[] = [];
  let inline: RemoteAppSelectionNode[] = [];
  const flush = () => {
    const paragraph = renderInline(inline)
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .trim();
    if (paragraph.length > 0) blocks.push(paragraph);
    inline = [];
  };
  for (const node of nodes) {
    if (!isBlock(node)) {
      inline.push(node);
      continue;
    }
    flush();
    const block = renderBlock(node);
    if (block.trim().length > 0) blocks.push(block);
  }
  flush();
  return blocks;
};

export const remoteAppSelectionToMarkdown = (
  nodes: ReadonlyArray<RemoteAppSelectionNode>,
): string => renderBlocks(nodes).join("\n\n").trim();
