/**
 * HTTP clients for one Hermes Agent: its API server (sessions and runs) and
 * its dashboard (config, keys, custom endpoints). Both speak JSON over plain
 * `fetch`, so a tailnet URL works the same as a local one.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { HermesSettings } from "../settings.ts";

export class HermesApiError extends Schema.TaggedError<HermesApiError>()("HermesApiError", {
  /** HTTP status; absent when the request never got a response. */
  status: Schema.optional(Schema.Number),
  /** Hermes's own error code, such as `session_active_turn`. */
  code: Schema.optional(Schema.String),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface HermesConnection {
  readonly apiUrl: string;
  readonly apiKey: string;
}

export interface HermesDashboardConnection {
  readonly dashboardUrl: string;
  readonly username: string;
  readonly password: string;
}

export const connectionOf = (settings: HermesSettings): HermesConnection => ({
  apiUrl: settings.apiUrl,
  apiKey: settings.apiKey,
});

export const dashboardConnectionOf = ({
  dashboardUrl,
  dashboardUsername,
  dashboardPassword,
}: HermesSettings): HermesDashboardConnection => ({
  dashboardUrl,
  username: dashboardUsername,
  password: dashboardPassword,
});

const REQUEST_TIMEOUT_MS = 30_000;
const TERMINAL_EVENTS = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
]);
export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}${path}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads Hermes's `{error: {message, code}}` or the dashboard's `{detail}` from a failed response. */
const errorFromResponse = async (response: Response, what: string) => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const message =
    (typeof error?.message === "string" && error.message) ||
    (isRecord(body) && typeof body.detail === "string" && body.detail) ||
    response.statusText ||
    "request failed";
  const code =
    (typeof error?.code === "string" && error.code) ||
    (isRecord(body) && typeof body.code === "string" ? body.code : undefined);
  return new HermesApiError({
    status: response.status,
    ...(code ? { code } : {}),
    detail: `${what} failed (${response.status}): ${message}`,
  });
};

const networkError = (what: string, cause: unknown) =>
  new HermesApiError({
    detail: `${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const fetchJson = (
  url: string,
  init: RequestInit & { readonly what: string },
): Effect.Effect<unknown, HermesApiError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (!response.ok) throw await errorFromResponse(response, init.what);
      const text = await response.text();
      return text ? (JSON.parse(text) as unknown) : undefined;
    },
    catch: (cause) => (cause instanceof HermesApiError ? cause : networkError(init.what, cause)),
  });

const requireApi = (connection: HermesConnection) =>
  connection.apiUrl
    ? Effect.void
    : Effect.fail(
        new HermesApiError({ detail: "Set the Hermes API URL in Settings › Providers." }),
      );

/** One JSON request to the Hermes API server. */
export const apiRequest = (
  connection: HermesConnection,
  method: string,
  path: string,
  options: { readonly body?: unknown; readonly headers?: Record<string, string> } = {},
) =>
  requireApi(connection).pipe(
    Effect.andThen(
      fetchJson(joinUrl(connection.apiUrl, path), {
        what: `Hermes ${method} ${path.split("?")[0]}`,
        method,
        headers: {
          Accept: "application/json",
          ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    ),
  );

// ── Sessions ──────────────────────────────────────────────────────────

export interface HermesSession {
  readonly id: string;
  readonly source: string | null;
  readonly model: string | null;
  readonly title: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly lastActive: number | null;
  readonly messageCount: number;
  readonly preview: string | null;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly parentSessionId: string | null;
}

const str = (value: unknown) => (typeof value === "string" && value ? value : null);
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const decodeSession = (value: unknown): HermesSession | undefined => {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  return {
    id: value.id,
    source: str(value.source),
    model: str(value.model),
    title: str(value.title),
    startedAt: num(value.started_at),
    endedAt: num(value.ended_at),
    lastActive: num(value.last_active) ?? num(value.started_at),
    messageCount: num(value.message_count) ?? 0,
    preview: str(value.preview),
    pinned: value.pinned === true,
    archived: value.archived === true,
    parentSessionId: str(value.parent_session_id),
  };
};

export const listSessions = (
  connection: HermesConnection,
  options: { readonly limit: number; readonly offset: number },
) =>
  apiRequest(
    connection,
    "GET",
    `/api/sessions?limit=${Math.min(200, options.limit)}&offset=${options.offset}`,
  ).pipe(
    Effect.map((body) => ({
      sessions: (isRecord(body) && Array.isArray(body.data) ? body.data : []).flatMap((entry) => {
        const session = decodeSession(entry);
        return session ? [session] : [];
      }),
      hasMore: isRecord(body) && body.has_more === true,
    })),
  );

const sessionPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;

/** Creates an empty session. No model is passed: that would lock the session to it. */
export const createSession = (connection: HermesConnection, title?: string) =>
  apiRequest(connection, "POST", "/api/sessions", { body: title ? { title } : {} }).pipe(
    Effect.flatMap((body) => {
      const session = decodeSession(isRecord(body) ? body.session : undefined);
      return session
        ? Effect.succeed(session)
        : Effect.fail(new HermesApiError({ detail: "Hermes returned no session." }));
    }),
  );

export const getSession = (connection: HermesConnection, id: string) =>
  apiRequest(connection, "GET", sessionPath(id)).pipe(
    Effect.map((body) =>
      decodeSession(isRecord(body) && isRecord(body.session) ? body.session : body),
    ),
  );

export const patchSession = (
  connection: HermesConnection,
  id: string,
  patch: { readonly title?: string; readonly pinned?: boolean; readonly archived?: boolean },
) => apiRequest(connection, "PATCH", sessionPath(id), { body: patch }).pipe(Effect.asVoid);

export const deleteSession = (connection: HermesConnection, id: string) =>
  apiRequest(connection, "DELETE", sessionPath(id)).pipe(Effect.asVoid);

export interface HermesToolCall {
  readonly id: string;
  readonly name: string;
  /** The call's arguments as Hermes stored them, usually a JSON object string. */
  readonly arguments: string;
}

export interface HermesMessage {
  readonly id: string;
  readonly role: string;
  readonly content: string;
  readonly timestamp: number | null;
  /** The calls an assistant message made; empty otherwise. */
  readonly toolCalls: ReadonlyArray<HermesToolCall>;
  /** On a `tool` message, the call it answers. */
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  readonly reasoning: string | null;
}

const MESSAGES_PAGE = 500;
// Bounds a very long session's walk; the newest messages past it stay in Hermes.
const MAX_MESSAGE_PAGES = 20;

const decodeToolCalls = (value: unknown): HermesToolCall[] =>
  (Array.isArray(value) ? value : []).flatMap((call, index): HermesToolCall[] => {
    if (!isRecord(call)) return [];
    const fn = isRecord(call.function) ? call.function : {};
    const name = str(fn.name) ?? str(call.name);
    if (name === null) return [];
    const args = fn.arguments ?? call.arguments;
    return [
      {
        id: str(call.id) ?? str(call.call_id) ?? `call-${index}`,
        name,
        arguments: typeof args === "string" ? args : args === undefined ? "" : JSON.stringify(args),
      },
    ];
  });

const decodeMessage = (entry: unknown, index: number): HermesMessage | undefined =>
  isRecord(entry) && typeof entry.role === "string"
    ? {
        id: entry.id === undefined ? `index-${index}` : String(entry.id),
        role: entry.role,
        content: typeof entry.content === "string" ? entry.content : "",
        timestamp: num(entry.timestamp),
        toolCalls: decodeToolCalls(entry.tool_calls),
        toolCallId: str(entry.tool_call_id),
        toolName: str(entry.tool_name),
        reasoning: str(entry.reasoning) ?? str(entry.reasoning_content),
      }
    : undefined;

/** A session's messages, oldest first, page by page. */
export const listMessages = (connection: HermesConnection, id: string) =>
  Effect.gen(function* () {
    const messages: HermesMessage[] = [];
    for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
      const body = yield* apiRequest(
        connection,
        "GET",
        `${sessionPath(id)}/messages?limit=${MESSAGES_PAGE}&offset=${page * MESSAGES_PAGE}&order=oldest`,
      );
      const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      data.forEach((entry, index) => {
        const message = decodeMessage(entry, page * MESSAGES_PAGE + index);
        if (message) messages.push(message);
      });
      if (data.length < MESSAGES_PAGE) break;
    }
    return messages;
  });

// ── Models ────────────────────────────────────────────────────────────

export const modelOptions = (connection: HermesConnection) =>
  apiRequest(connection, "GET", "/api/model/options");

// ── Runs ──────────────────────────────────────────────────────────────

export interface HermesRunRequest {
  readonly input: string;
  readonly sessionId: string;
  readonly model?: string;
  readonly provider?: string;
  readonly reasoningEffort?: string;
  readonly fast?: boolean;
  readonly instructions?: string;
  readonly idempotencyKey: string;
}

export const startRun = (connection: HermesConnection, request: HermesRunRequest) => {
  const modelOptions = {
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.fast === undefined ? {} : { fast: request.fast }),
  };
  return apiRequest(connection, "POST", "/v1/runs", {
    headers: { "Idempotency-Key": request.idempotencyKey },
    body: {
      input: request.input,
      session_id: request.sessionId,
      ...(request.model ? { model: request.model } : {}),
      ...(request.provider ? { provider: request.provider } : {}),
      ...(Object.keys(modelOptions).length ? { model_options: modelOptions } : {}),
      ...(request.instructions ? { instructions: request.instructions } : {}),
    },
  }).pipe(
    Effect.flatMap((body) =>
      isRecord(body) && typeof body.run_id === "string"
        ? Effect.succeed(body.run_id)
        : Effect.fail(new HermesApiError({ detail: "Hermes accepted the run without an id." })),
    ),
  );
};

const runPath = (runId: string) => `/v1/runs/${encodeURIComponent(runId)}`;

export const getRun = (connection: HermesConnection, runId: string) =>
  apiRequest(connection, "GET", runPath(runId)).pipe(
    Effect.map((body) => (isRecord(body) ? body : {})),
  );

export const stopRun = (connection: HermesConnection, runId: string) =>
  apiRequest(connection, "POST", `${runPath(runId)}/stop`, { body: {} }).pipe(Effect.asVoid);

export const steerRun = (connection: HermesConnection, runId: string, input: string) =>
  apiRequest(connection, "POST", `${runPath(runId)}/steer`, { body: { input } }).pipe(
    Effect.asVoid,
  );

export const answerApproval = (
  connection: HermesConnection,
  runId: string,
  choice: "once" | "session" | "always" | "deny",
  requestId?: string,
) =>
  apiRequest(connection, "POST", `${runPath(runId)}/approval`, {
    body: { choice, ...(requestId ? { request_id: requestId } : {}) },
  }).pipe(Effect.asVoid);

/** One structured run event: `event` names it, the rest are its fields. */
export type HermesRunEvent = Record<string, unknown> & { readonly event: string };

const RECONNECT_ATTEMPTS = 5;

/**
 * Follows a run's SSE stream until a terminal event, resuming with
 * `Last-Event-ID` when the connection drops. When the stream closes without
 * one (the run outlived its replay buffer), the run's status stands in for it.
 */
export async function* runEvents(
  connection: HermesConnection,
  runId: string,
  signal: AbortSignal,
): AsyncGenerator<HermesRunEvent> {
  let lastId: string | undefined;
  let failures = 0;
  while (!signal.aborted) {
    let closedCleanly = false;
    try {
      const response = await fetch(joinUrl(connection.apiUrl, `${runPath(runId)}/events`), {
        headers: {
          Accept: "text/event-stream",
          ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
          ...(lastId === undefined ? {} : { "Last-Event-ID": lastId }),
        },
        signal,
      });
      if (!response.ok || !response.body) {
        if (response.status === 404 && lastId !== undefined) break;
        throw await errorFromResponse(response, "Hermes run events");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let data: Array<string> = [];
      let id: string | undefined;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        failures = 0;
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line === "") {
            if (data.length) {
              const payload = JSON.parse(data.join("\n")) as unknown;
              if (id !== undefined) lastId = id;
              if (isRecord(payload) && typeof payload.event === "string") {
                yield payload as HermesRunEvent;
                if (TERMINAL_EVENTS.has(payload.event)) return;
              }
            }
            data = [];
            id = undefined;
          } else if (line.startsWith(": stream closed")) {
            closedCleanly = true;
          } else if (line.startsWith(":")) {
            // Comment frame: open or keepalive.
          } else if (line.startsWith("data:")) {
            data.push(line.slice(5).replace(/^ /, ""));
          } else if (line.startsWith("id:")) {
            id = line.slice(3).trim();
          }
        }
      }
    } catch (cause) {
      if (signal.aborted) return;
      if (cause instanceof HermesApiError && cause.status !== undefined) throw cause;
      if (++failures > RECONNECT_ATTEMPTS) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 1000 * failures));
      continue;
    }
    if (closedCleanly) break;
  }
  if (signal.aborted) return;
  // The stream ended without a terminal event; read the run's own status.
  const status = await Effect.runPromise(getRun(connection, runId));
  const state = typeof status.status === "string" ? status.status : "failed";
  yield {
    ...status,
    event: TERMINAL_RUN_STATUSES.has(state) ? `run.${state}` : "run.failed",
    ...(TERMINAL_RUN_STATUSES.has(state)
      ? {}
      : { error: "Hermes closed the run's event stream before it finished." }),
  };
}

// ── Dashboard ─────────────────────────────────────────────────────────

const DASHBOARD_TOKEN_TTL_MS = 11 * 60 * 60 * 1000;
const dashboardTokens = new Map<string, { readonly token: string; readonly expiresAt: number }>();

const dashboardLogin = (connection: HermesDashboardConnection) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(joinUrl(connection.dashboardUrl, "/auth/password-login"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          provider: "basic",
          username: connection.username,
          password: connection.password,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (!response.ok) throw await errorFromResponse(response, "Hermes dashboard sign-in");
      const cookie = response.headers
        .getSetCookie()
        .map((entry) => /^hermes_session_at=([^;]+)/.exec(entry)?.[1])
        .find((value) => value !== undefined);
      if (!cookie)
        throw new HermesApiError({ detail: "Hermes dashboard sign-in returned no session." });
      return decodeURIComponent(cookie);
    },
    catch: (cause) =>
      cause instanceof HermesApiError ? cause : networkError("Hermes dashboard sign-in", cause),
  });

const dashboardToken = (connection: HermesDashboardConnection, fresh: boolean) =>
  Effect.gen(function* () {
    const key = `${connection.dashboardUrl}\u0000${connection.username}`;
    const cached = dashboardTokens.get(key);
    if (!fresh && cached && cached.expiresAt > Date.now()) return cached.token;
    const token = yield* dashboardLogin(connection);
    dashboardTokens.set(key, { token, expiresAt: Date.now() + DASHBOARD_TOKEN_TTL_MS });
    return token;
  });

/** One JSON request to the Hermes dashboard, signing in again once when its session expired. */
export const dashboardRequest = (
  connection: HermesDashboardConnection,
  method: string,
  path: string,
  body?: unknown,
) => {
  if (!connection.dashboardUrl)
    return Effect.fail(
      new HermesApiError({ detail: "Set the Hermes dashboard URL in Settings › Providers." }),
    );
  const send = (fresh: boolean) =>
    Effect.gen(function* () {
      const token =
        connection.username || connection.password
          ? yield* dashboardToken(connection, fresh)
          : undefined;
      return yield* fetchJson(joinUrl(connection.dashboardUrl, path), {
        what: `Hermes dashboard ${method} ${path.split("?")[0]}`,
        method,
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    });
  return send(false).pipe(
    Effect.catchIf(
      (error) => error.status === 401,
      () => send(true),
    ),
  );
};

// ── Cron reports ──────────────────────────────────────────────────────

export interface HermesCronJob {
  readonly id: string;
  readonly name: string | null;
  /** Where the job delivers, such as `discord:<chat>:<thread>` or `local`. */
  readonly deliver: string | null;
  /** The Hermes home the job's output docs live under. */
  readonly hermesHome: string | null;
}

/** One cron job, or undefined when Hermes has no such job. */
export const getCronJob = (connection: HermesDashboardConnection, jobId: string) =>
  dashboardRequest(connection, "GET", `/api/cron/jobs/${encodeURIComponent(jobId)}`).pipe(
    Effect.map((body): HermesCronJob | undefined =>
      isRecord(body) && typeof body.id === "string"
        ? {
            id: body.id,
            name: str(body.name),
            deliver: str(body.deliver),
            hermesHome: str(body.hermes_home),
          }
        : undefined,
    ),
    Effect.catchIf(
      (error) => error.status === 404,
      () => Effect.succeed(undefined),
    ),
  );

/** The session ids of a cron job's recent agent runs, newest first. */
export const listCronRunSessionIds = (
  connection: HermesDashboardConnection,
  jobId: string,
  limit: number,
) =>
  dashboardRequest(
    connection,
    "GET",
    `/api/cron/jobs/${encodeURIComponent(jobId)}/runs?limit=${limit}`,
  ).pipe(
    Effect.map((body) =>
      (isRecord(body) && Array.isArray(body.runs) ? body.runs : []).flatMap((run) =>
        isRecord(run) && typeof run.id === "string" && run.source === "cron" ? [run.id] : [],
      ),
    ),
  );

/** File names in a directory on the Hermes host, read through the dashboard. */
export const listHostDirectory = (connection: HermesDashboardConnection, path: string) =>
  dashboardRequest(connection, "GET", `/api/fs/list?path=${encodeURIComponent(path)}`).pipe(
    Effect.map((body) =>
      (isRecord(body) && Array.isArray(body.entries) ? body.entries : []).flatMap((entry) =>
        isRecord(entry) && typeof entry.name === "string" && entry.isDirectory !== true
          ? [entry.name]
          : [],
      ),
    ),
  );

/** A text file on the Hermes host, read through the dashboard; undefined for binary. */
export const readHostTextFile = (connection: HermesDashboardConnection, path: string) =>
  dashboardRequest(connection, "GET", `/api/fs/read-text?path=${encodeURIComponent(path)}`).pipe(
    Effect.map((body) =>
      isRecord(body) && body.binary !== true && typeof body.text === "string"
        ? body.text
        : undefined,
    ),
  );
