/**
 * Read-only reader for openbot.db, OpenBot's conversation of record. The
 * Local scripts API cannot read history, so T3 reads it here and never writes.
 */
import { openBotAgentLabel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { query, type OpenBotLocation, type OpenBotQuery, type OpenBotRow as Row } from "./host.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const text = (value: unknown) => str(value)?.trim() || undefined;
const timeMs = (value: unknown) => {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
};

const queryOne = (location: OpenBotLocation, sql: string, params?: ReadonlyArray<string | number>) =>
  query(location, [{ sql, ...(params === undefined ? {} : { params }) }]).pipe(
    Effect.map(([rows]) => rows ?? []),
  );

export const mainThreadId = (agentId: string) => `openbot-thread-${agentId}`;
/** The agent whose main conversation this is, or undefined for a side thread. */
export const agentOfThread = (threadId: string) =>
  threadId.startsWith("openbot-thread-agent-") ? threadId.slice("openbot-thread-".length) : undefined;

export const agentLabel = (agent: { readonly name: string; readonly title: string | undefined }) =>
  openBotAgentLabel(agent.name, agent.title);

/** A T3 model slug for one of OpenBot's provider and model pairs: "codex/gpt-5". */
export const modelSlug = (provider: string, model: string) => `${provider}/${model}`;
/** The pair a slug names; undefined for anything else, such as an agent id from older threads. */
export const parseModelSlug = (slug: string) => {
  const slash = slug.indexOf("/");
  return slash > 0 && slash < slug.length - 1
    ? { provider: slug.slice(0, slash), model: slug.slice(slash + 1) }
    : undefined;
};

export interface OpenBotAgentRecord {
  readonly id: string;
  readonly name: string;
  readonly title: string | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly localScripts: boolean;
}

export interface OpenBotThreadRecord {
  readonly id: string;
  readonly agentId: string;
  readonly title: string;
  readonly side: boolean;
  readonly running: boolean;
  readonly outcome: string | undefined;
  readonly updatedAt: string;
  readonly messageCount: number;
}

const DIRECTORY_QUERIES: ReadonlyArray<OpenBotQuery> = [
  {
    sql: `SELECT agent_id,
              json_extract(agent_json, '$.name') AS name,
              json_extract(agent_json, '$.title') AS title,
              json_extract(agent_json, '$.provider') AS provider,
              json_extract(agent_json, '$.model') AS model,
              json_extract(agent_json, '$.allowAutomation') AS local_scripts
         FROM projection_agents
        ORDER BY sort_order`,
  },
  {
    sql: `SELECT t.thread_id, t.agent_id, t.title, t.active_turn_id, t.updated_at,
              a.outcome,
              (SELECT COUNT(*) FROM projection_thread_messages m
                WHERE m.thread_id = t.thread_id) AS message_count
         FROM projection_threads t
         LEFT JOIN projection_agent_threads a ON a.thread_id = t.thread_id
        WHERE a.archived_at IS NULL
        ORDER BY t.updated_at DESC`,
  },
];

const directoryFrom = (agentRows: ReadonlyArray<Row>, threadRows: ReadonlyArray<Row>) => {
  const agents = agentRows.flatMap((row: Row): Array<OpenBotAgentRecord> => {
    const id = str(row.agent_id);
    return id
      ? [
          {
            id,
            name: text(row.name) ?? id,
            title: text(row.title),
            provider: text(row.provider),
            model: text(row.model),
            localScripts: row.local_scripts === 1,
          },
        ]
      : [];
  });
  const threads = threadRows.flatMap((row: Row): Array<OpenBotThreadRecord> => {
    const id = str(row.thread_id);
    const agentId = str(row.agent_id);
    if (!id || !agentId) return [];
    return [
      {
        id,
        agentId,
        title: text(row.title) ?? "Untitled",
        side: id !== mainThreadId(agentId),
        running: row.active_turn_id !== null,
        outcome: str(row.outcome),
        updatedAt: str(row.updated_at) ?? "",
        messageCount: Number(row.message_count ?? 0),
      },
    ];
  });
  return { agents, threads };
};

/** Every agent, and every thread not archived in OpenBot, newest first. */
export const readDirectory = (location: OpenBotLocation) =>
  query(location, DIRECTORY_QUERIES).pipe(
    Effect.map(([agentRows = [], threadRows = []]) => directoryFrom(agentRows, threadRows)),
  );

const AGENT_NAMES: OpenBotQuery = {
  sql: `SELECT agent_id, json_extract(agent_json, '$.name') AS name FROM projection_agents`,
};

const namesFrom = (rows: ReadonlyArray<Row>): ReadonlyMap<string, string> =>
  new Map(
    rows.flatMap((row: Row): Array<[string, string]> => {
      const id = str(row.agent_id);
      return id ? [[id, text(row.name) ?? id]] : [];
    }),
  );

/**
 * What a turn needs before it sends, in one read: agent names for exchanges, the newest event
 * sequence (the turn reads only rows changed after it), and the agent's provider and model.
 */
export const turnContext = (location: OpenBotLocation, agentId: string) =>
  query(location, [
    AGENT_NAMES,
    { sql: `SELECT MAX(last_event_sequence) AS sequence FROM projection_thread_messages` },
    {
      sql: `SELECT json_extract(agent_json, '$.provider') AS provider,
                   json_extract(agent_json, '$.model') AS model
              FROM projection_agents
             WHERE agent_id = ?`,
      params: [agentId],
    },
  ]).pipe(
    Effect.map(([names = [], [sequence] = [], [agent] = []]) => ({
      names: namesFrom(names),
      sequence: Number(sequence?.sequence ?? 0),
      provider: text(agent?.provider),
      model: text(agent?.model),
    })),
  );

/**
 * The provider and model pairs OpenBot runs: those its agents use and those of its active
 * provider sessions. OpenBot keeps its full catalog in memory and its API does not list it.
 */
export const readModels = (location: OpenBotLocation) =>
  queryOne(
    location,
    `SELECT json_extract(agent_json, '$.provider') AS provider,
            json_extract(agent_json, '$.model') AS model
       FROM projection_agents
     UNION
     SELECT provider, model FROM projection_provider_sessions WHERE state = 'active'`,
  ).pipe(
    Effect.map((rows) =>
      rows.flatMap((row: Row) => {
        const provider = text(row.provider);
        const model = text(row.model);
        return provider && model && !provider.includes("/") ? [{ provider, model }] : [];
      }),
    ),
  );

export interface OpenBotMessageRow {
  readonly messageId: string;
  readonly author: string;
  readonly itemType: string | undefined;
  readonly createdAt: string;
  readonly sequence: number;
  readonly settled: boolean;
  readonly body: Record<string, unknown>;
}

const UNSETTLED = new Set(["pending", "queued", "running", "streaming", "in_progress"]);

const messagesQuery = (threadId: string, afterSequence: number): OpenBotQuery => ({
  sql: `SELECT message_id, author, status, item_type, created_at, last_event_sequence, message_json
          FROM projection_thread_messages
         WHERE thread_id = ? AND last_event_sequence > ?
         ORDER BY created_at, ordinal`,
  params: [threadId, afterSequence],
});

const messageRows = (rows: ReadonlyArray<Row>) =>
  rows.flatMap((row: Row): Array<OpenBotMessageRow> => {
    const messageId = str(row.message_id);
    let body: unknown;
    try {
      body = JSON.parse(str(row.message_json) ?? "null");
    } catch {
      body = undefined;
    }
    if (!messageId || !isRecord(body)) return [];
    return [
      {
        messageId,
        author: str(row.author) ?? "",
        itemType: str(row.item_type),
        createdAt: str(row.created_at) ?? "",
        sequence: Number(row.last_event_sequence ?? 0),
        settled: !UNSETTLED.has(str(row.status) ?? ""),
        body,
      },
    ];
  });

/** A thread's messages in OpenBot's order; only those changed after `afterSequence` when given. */
export const readRows = (location: OpenBotLocation, threadId: string, afterSequence = -1) =>
  query(location, [messagesQuery(threadId, afterSequence)]).pipe(
    Effect.map(([rows = []]) => messageRows(rows)),
  );

/** The directory and one thread's whole history, in one read. */
export const readConversation = (location: OpenBotLocation, threadId: string) =>
  query(location, [...DIRECTORY_QUERIES, messagesQuery(threadId, -1)]).pipe(
    Effect.map(([agentRows = [], threadRows = [], rows = []]) => ({
      ...directoryFrom(agentRows, threadRows),
      rows: messageRows(rows),
    })),
  );

/** A thread's whole history and the agent names its exchanges mention, in one read. */
export const readHistory = (location: OpenBotLocation, threadId: string) =>
  query(location, [messagesQuery(threadId, -1), AGENT_NAMES]).pipe(
    Effect.map(([rows = [], names = []]) => ({ rows: messageRows(rows), names: namesFrom(names) })),
  );

export type OpenBotEntry =
  | {
      readonly kind: "message";
      readonly key: string;
      readonly atMs: number;
      readonly role: "user" | "assistant";
      readonly text: string;
    }
  | { readonly kind: "reasoning"; readonly key: string; readonly atMs: number; readonly text: string }
  | { readonly kind: "notice"; readonly key: string; readonly atMs: number; readonly text: string }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly atMs: number;
      readonly title: string;
      readonly command: string | undefined;
      readonly failed: boolean;
    };

const records = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);

const traceEntries = (key: string, trace: unknown): Array<OpenBotEntry> =>
  records(isRecord(trace) ? trace.steps : undefined).flatMap((step): Array<OpenBotEntry> => {
    const id = str(step.id);
    // Message and reasoning steps carry no text; the row itself holds the answer.
    if (!id || step.kind !== "tool") return [];
    return [
      {
        kind: "tool",
        key: `${key}:step:${id}`,
        atMs: timeMs(step.startedAt),
        title: text(step.text) ?? "Tool call",
        command: text(step.command),
        failed: step.failed === true,
      },
    ];
  });

const planMarkdown = (plan: unknown) => {
  if (!isRecord(plan)) return undefined;
  const steps = records(plan.steps).flatMap((step) => {
    const label = text(step.text);
    return label ? [`- [${step.status === "completed" ? "x" : " "}] ${label}`] : [];
  });
  return [text(plan.explanation), steps.join("\n")].filter(Boolean).join("\n\n") || undefined;
};

const questionNotice = (prompt: unknown) => {
  if (!isRecord(prompt)) return undefined;
  const questions = records(prompt.questions).flatMap((question) => {
    const asked = text(question.question);
    return asked ? [asked] : [];
  });
  if (questions.length === 0) return undefined;
  const answered = isRecord(prompt.resolution) && prompt.resolution.status === "answered";
  return `OpenBot asked: ${questions.join(" ")}\n\n${answered ? "Answered in OpenBot." : "Answer it in OpenBot."}`;
};

const exchangeText = (body: Record<string, unknown>, names: ReadonlyMap<string, string>) => {
  const said = text(body.text);
  const exchange = isRecord(body.exchange) ? body.exchange : undefined;
  if (!said || !exchange) return said;
  const nameOf = (id: unknown) => names.get(str(id) ?? "") ?? str(id) ?? "another agent";
  const header =
    exchange.direction === "outgoing"
      ? `**To ${(Array.isArray(exchange.recipientAgentIds) ? exchange.recipientAgentIds : []).map(nameOf).join(", ") || "another agent"}**`
      : `**From ${nameOf(exchange.senderAgentId ?? body.senderAgentId)}**`;
  return `${header}\n\n${said}`;
};

/** One OpenBot message as T3 entries, keyed stably so a re-read updates rather than duplicates. */
export const rowEntries = (
  row: OpenBotMessageRow,
  names: ReadonlyMap<string, string>,
): Array<OpenBotEntry> => {
  const { body, messageId: key } = row;
  const atMs = timeMs(body.createdAt ?? row.createdAt);
  const said = text(body.text);
  const message = (role: "user" | "assistant", value: string | undefined): Array<OpenBotEntry> =>
    value ? [{ kind: "message", key, atMs, role, text: value }] : [];
  const notice = (value: string | undefined): Array<OpenBotEntry> =>
    value ? [{ kind: "notice", key: `${key}:notice`, atMs, text: value }] : [];
  if (row.author === "user") return message("user", said);
  switch (row.itemType) {
    case "commentary":
      return said ? [{ kind: "reasoning", key, atMs, text: said }] : [];
    case "plan":
      return message("assistant", planMarkdown(body.plan));
    case "question_prompt":
      return notice(questionNotice(body.questionPrompt));
    case "agent-exchange":
      return message("assistant", exchangeText(body, names));
    case "memory-changes": {
      const changes = records(body.memoryChanges).flatMap((change) => {
        const saved = text(change.text);
        return saved ? [`- ${str(change.action) ?? "changed"}: ${saved}`] : [];
      });
      return notice(changes.length ? `OpenBot memory changed:\n${changes.join("\n")}` : undefined);
    }
    case undefined:
    case "agentMessage":
    case "final_answer":
      return [...traceEntries(key, body.trace), ...message("assistant", said)];
    default:
      return row.author === "assistant" ? message("assistant", said) : notice(said);
  }
};
