/**
 * OpenBot's Local scripts API, served on loopback by the OpenBot app. OpenBot
 * rewrites its URL and token on every restart, so each request reads them from
 * the config folder; the token never leaves this module and is never logged.
 */
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { OpenBotSettings } from "../settings.ts";

export class OpenBotError extends Schema.TaggedError<OpenBotError>()("OpenBotError", {
  /** HTTP status; absent when no response came back. */
  status: Schema.optional(Schema.Number),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
export const ENDED_DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

const defaultConfigDir = () => {
  const home = NodeOs.homedir();
  if (process.platform === "darwin")
    return NodePath.join(home, "Library", "Application Support", "OpenBot");
  if (process.platform === "win32")
    return NodePath.join(process.env.APPDATA || NodePath.join(home, "AppData", "Roaming"), "OpenBot");
  return NodePath.join(process.env.XDG_CONFIG_HOME || NodePath.join(home, ".config"), "OpenBot");
};

/** OpenBot's config folder: the setting, or OpenBot's default on this machine. */
export const configDirOf = ({ configDir }: Pick<OpenBotSettings, "configDir">) => {
  if (!configDir) return defaultConfigDir();
  return configDir === "~" || configDir.startsWith("~/")
    ? NodePath.join(NodeOs.homedir(), configDir.slice(1))
    : configDir;
};

const readAutomation = (configDir: string) => {
  const folder = NodePath.join(configDir, "automation");
  return Effect.tryPromise({
    try: async () => {
      const [url, token] = await Promise.all([
        NodeFs.readFile(NodePath.join(folder, "url"), "utf8"),
        NodeFs.readFile(NodePath.join(folder, "token"), "utf8"),
      ]);
      return { url: url.trim().replace(/\/+$/, ""), token: token.trim() };
    },
    catch: () =>
      new OpenBotError({
        detail: `OpenBot's Local scripts are not reachable: ${folder} has no URL and token. Is OpenBot running here with Local scripts on for an agent?`,
      }),
  });
};

const failureDetail = (what: string, status: number, body: unknown) => {
  if (status === 401) return "OpenBot refused its Local scripts token. Restart OpenBot and try again.";
  if (status === 403)
    return "Local scripts are off for this agent. Turn them on in OpenBot to message it from T3 Code.";
  const reason = (isRecord(body) && str(body.error)) || `HTTP ${status}`;
  return `${what} failed: ${reason}`;
};

const send = (configDir: string, method: "GET" | "POST", path: string, body?: unknown) => {
  const what = `OpenBot ${method} ${path.split("?")[0]}`;
  return readAutomation(configDir).pipe(
    Effect.flatMap((automation) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(`${automation.url}${path}`, {
            method,
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${automation.token}`,
              ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          });
          const text = await response.text();
          let parsed: unknown;
          try {
            parsed = text ? (JSON.parse(text) as unknown) : undefined;
          } catch {
            parsed = undefined;
          }
          if (!response.ok)
            throw new OpenBotError({
              status: response.status,
              detail: failureDetail(what, response.status, parsed),
            });
          return parsed;
        },
        catch: (cause) =>
          cause instanceof OpenBotError
            ? cause
            : new OpenBotError({
                detail: `${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
      }),
    ),
  );
};

/** One JSON request. OpenBot writes a new token when it restarts, so a 401 rereads it once. */
const request = (configDir: string, method: "GET" | "POST", path: string, body?: unknown) =>
  send(configDir, method, path, body).pipe(
    Effect.catchIf(
      (error) => error.status === 401,
      () => send(configDir, method, path, body),
    ),
  );

const agentPath = (agentId: string) => `/v1/agents/${encodeURIComponent(agentId)}`;

export interface OpenBotScriptAgent {
  readonly id: string;
  readonly name: string;
}

/** The agents with Local scripts on: the only ones T3 can message. */
export const listAgents = (configDir: string) =>
  request(configDir, "GET", "/v1/agents").pipe(
    Effect.map((body): ReadonlyArray<OpenBotScriptAgent> => {
      const items = Array.isArray(body)
        ? body
        : isRecord(body) && Array.isArray(body.agents)
          ? body.agents
          : [];
      return items.flatMap((item: unknown) => {
        const id = isRecord(item) ? str(item.id) : undefined;
        return id && isRecord(item) ? [{ id, name: str(item.name) || id }] : [];
      });
    }),
  );

/** Queues a message for the agent; returns the delivery that carries it to that agent. */
export const sendMessage = (
  configDir: string,
  agentId: string,
  text: string,
  clientMessageId: string,
) =>
  request(configDir, "POST", `${agentPath(agentId)}/messages`, { text, clientMessageId }).pipe(
    Effect.flatMap((body) => {
      const deliveries = isRecord(body) && Array.isArray(body.deliveries) ? body.deliveries : [];
      const delivery =
        deliveries.find((item: unknown) => isRecord(item) && item.recipientAgentId === agentId) ??
        deliveries[0];
      const deliveryId = isRecord(delivery) ? str(delivery.id) : undefined;
      return deliveryId
        ? Effect.succeed(deliveryId)
        : Effect.fail(new OpenBotError({ detail: "OpenBot accepted the message but named no delivery." }));
    }),
  );

export interface OpenBotDelivery {
  readonly status: string;
  readonly error: string | undefined;
  readonly answer: string | undefined;
}

export const getDelivery = (configDir: string, agentId: string, deliveryId: string) =>
  request(
    configDir,
    "GET",
    `${agentPath(agentId)}/deliveries/${encodeURIComponent(deliveryId)}`,
  ).pipe(
    Effect.map(
      (body): OpenBotDelivery => ({
        status: (isRecord(body) && str(body.status)) || "queued",
        error: isRecord(body) ? str(body.error) : undefined,
        answer: isRecord(body) ? str(body.answer) : undefined,
      }),
    ),
  );

/** How many questions, approvals and browser takeovers wait for a person in OpenBot. */
export const pendingCount = (configDir: string, agentId: string) =>
  request(configDir, "GET", `${agentPath(agentId)}/pending`).pipe(
    Effect.map((body) =>
      isRecord(body)
        ? ["prompts", "approvals", "browserTakeovers"].reduce(
            (count, key) => count + (Array.isArray(body[key]) ? body[key].length : 0),
            0,
          )
        : 0,
    ),
  );
