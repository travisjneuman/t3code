/**
 * OpenBot's Local scripts API, served on loopback by the OpenBot app. OpenBot
 * rewrites its URL and token on every restart, so host.ts reads them for each
 * request where OpenBot runs; the token is never returned or logged.
 */
import * as Effect from "effect/Effect";

import { call, OpenBotError, type OpenBotLocation } from "./host.ts";

export { OpenBotError, type OpenBotLocation } from "./host.ts";

export const ENDED_DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

const failureDetail = (what: string, status: number, body: unknown) => {
  if (status === 401) return "OpenBot refused its Local scripts token. Restart OpenBot and try again.";
  if (status === 403)
    return "Local scripts are off for this agent. Turn them on in OpenBot to message it from T3 Code.";
  const reason = (isRecord(body) && str(body.error)) || `HTTP ${status}`;
  return `${what} failed: ${reason}`;
};

const send = (location: OpenBotLocation, method: "GET" | "POST", path: string, body?: unknown) => {
  const what = `OpenBot ${method} ${path.split("?")[0]}`;
  return call(location, {
    method,
    path,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).pipe(
    Effect.flatMap((reply) => {
      if ("missing" in reply)
        return Effect.fail(
          new OpenBotError({
            detail: `OpenBot's Local scripts are not reachable: ${reply.missing}${location.sshHost ? ` on ${location.sshHost}` : ""} has no URL and token. Is OpenBot running there with Local scripts on for an agent?`,
          }),
        );
      if ("failed" in reply)
        return Effect.fail(new OpenBotError({ detail: `${what} failed: ${reply.failed}` }));
      let parsed: unknown;
      try {
        parsed = reply.text ? (JSON.parse(reply.text) as unknown) : undefined;
      } catch {
        parsed = undefined;
      }
      return reply.status >= 200 && reply.status < 300
        ? Effect.succeed(parsed)
        : Effect.fail(
            new OpenBotError({
              status: reply.status,
              detail: failureDetail(what, reply.status, parsed),
            }),
          );
    }),
  );
};

/** One JSON request. OpenBot writes a new token when it restarts, so a 401 rereads it once. */
const request = (
  location: OpenBotLocation,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) =>
  send(location, method, path, body).pipe(
    Effect.catchIf(
      (error) => error.status === 401,
      () => send(location, method, path, body),
    ),
  );

const agentPath = (agentId: string) => `/v1/agents/${encodeURIComponent(agentId)}`;

export interface OpenBotScriptAgent {
  readonly id: string;
  readonly name: string;
}

/** The agents with Local scripts on: the only ones T3 can message. */
export const listAgents = (location: OpenBotLocation) =>
  request(location, "GET", "/v1/agents").pipe(
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
  location: OpenBotLocation,
  agentId: string,
  text: string,
  clientMessageId: string,
) =>
  request(location, "POST", `${agentPath(agentId)}/messages`, { text, clientMessageId }).pipe(
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

export const getDelivery = (location: OpenBotLocation, agentId: string, deliveryId: string) =>
  request(
    location,
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

/** What OpenBot's Local scripts may change on an agent; it refuses every other setting. */
export interface OpenBotAgentSettings {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

/**
 * Moves the agent to another provider, model or reasoning effort, as its controls in OpenBot do.
 * It applies to all of the agent's conversations from its next message. OpenBot answers 409 for
 * a model or effort its providers do not list, and for a provider change while the agent works.
 */
export const setAgentSettings = (
  location: OpenBotLocation,
  agentId: string,
  settings: OpenBotAgentSettings,
) => {
  const target = [settings.model, settings.reasoningEffort && `${settings.reasoningEffort} effort`]
    .filter(Boolean)
    .join(" at ");
  return request(location, "POST", `${agentPath(agentId)}/settings`, settings).pipe(
    Effect.asVoid,
    Effect.mapError(
      (error) =>
        new OpenBotError({
          ...(error.status === undefined ? {} : { status: error.status }),
          detail:
            error.status === 409
              ? `OpenBot would not move this agent to ${target}: ${error.detail.replace(/^.*? failed: /, "")}`
              : error.detail,
        }),
    ),
  );
};

/** How many questions, approvals and browser takeovers wait for a person in OpenBot. */
export const pendingCount = (location: OpenBotLocation, agentId: string) =>
  request(location, "GET", `${agentPath(agentId)}/pending`).pipe(
    Effect.map((body) =>
      isRecord(body)
        ? ["prompts", "approvals", "browserTakeovers"].reduce(
            (count, key) => count + (Array.isArray(body[key]) ? body[key].length : 0),
            0,
          )
        : 0,
    ),
  );
