/**
 * The bridge key Hermes presents to T3's `/mcp` when the T3 tools switch is
 * on. Hermes's MCP config is global and its runs carry no headers, so one key
 * per Hermes instance stands for that instance, and each call acts as the
 * instance's one T3 thread that is running a turn: parent links, liveness and
 * mode caps then follow the normal thread-caller paths. With no such thread,
 * or several, the call is refused rather than guessed. Fork add-on; see
 * docs/user/hermes.md.
 *
 * @module hermes/HermesMcpBridge
 */
import { timingSafeEqual } from "node:crypto";

import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HermesSettings } from "@t3tools/provider-hermes/settings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * The T3 tools Hermes may call. The `t3-code` MCP server config lists only
 * these, and `refuseUnboundRequest` refuses any other tool at call time, so a
 * Hermes that ignores or loses its `tools.include` still can't reach the rest
 * of the orchestration tools its thread scope would otherwise allow.
 */
export const HERMES_T3_TOOLS = [
  "t3_project_list",
  "t3_project_read",
  "t3_thread_launch",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_wait",
  "t3_thread_send",
  "t3_thread_interrupt",
  "orchestrator_capabilities",
] as const;

const ALLOWED_TOOLS: ReadonlySet<string> = new Set(HERMES_T3_TOOLS);

/** What the bridge gates on a request; `unbound` is why every call is refused. */
export interface HermesBridgeRefusal {
  readonly unbound?: string;
}

export interface HermesBridgeCaller {
  readonly scope: McpInvocationContext.McpInvocationScope;
  /**
   * Always set by `resolve`, so the MCP auth hook (which skips the gate only
   * when this is absent) checks every bridged request against the allowlist.
   */
  readonly refusal?: HermesBridgeRefusal;
}

export class HermesMcpBridge extends Context.Service<
  HermesMcpBridge,
  {
    /** The caller for a Hermes bridge key, or undefined when the token is not one. */
    readonly resolve: (token: string) => Effect.Effect<HermesBridgeCaller | undefined>;
  }
>()("t3/hermes/HermesMcpBridge") {}

const HERMES_DRIVER = ProviderDriverKind.make("hermes");
const decodeHermesSettings = Schema.decodeUnknownOption(HermesSettings);

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;

  const digest = (text: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(Effect.orDie);

  /** The instance whose switched-on key matches, with its agent name. */
  const instanceFor = Effect.fn("HermesMcpBridge.instanceFor")(function* (token: string) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.option);
    if (Option.isNone(settings)) return undefined;
    const presented = yield* digest(token);
    for (const [instanceId, instance] of Object.entries(settings.value.providerInstances)) {
      if (instance.driver !== HERMES_DRIVER || instance.enabled === false) continue;
      const config = Option.getOrUndefined(decodeHermesSettings(instance.config ?? {}));
      if (config === undefined || !config.t3Tools || config.t3ToolsKey === "") continue;
      const expected = yield* digest(config.t3ToolsKey);
      if (timingSafeEqual(presented, expected)) {
        return {
          instanceId: ProviderInstanceId.make(instanceId),
          agentName: config.agentName || "Hermes",
        };
      }
    }
    return undefined;
  });

  /** The instance's T3 threads with a run in progress, as `threadAccess` counts one. */
  const runningThreads = (instanceId: ProviderInstanceId) =>
    sql<{ readonly thread_id: string }>`
      SELECT DISTINCT t.thread_id AS thread_id
      FROM orchestration_v2_projection_provider_threads p
      JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
      WHERE json_valid(p.payload_json)
        AND json_extract(p.payload_json, '$.driver') = ${HERMES_DRIVER}
        AND json_extract(p.payload_json, '$.providerInstanceId') = ${instanceId}
        AND t.active_provider_thread_id = p.provider_thread_id
        AND t.deleted_at IS NULL
        AND t.archived_at IS NULL
        AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs r
          WHERE r.thread_id = t.thread_id
            AND r.status IN ('preparing', 'starting', 'running')
        )
    `.pipe(
      Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))),
      Effect.orElseSucceed(() => []),
    );

  const resolve: HermesMcpBridge["Service"]["resolve"] = Effect.fn("HermesMcpBridge.resolve")(
    function* (token) {
      if (token.length === 0) return undefined;
      const match = yield* instanceFor(token);
      if (match === undefined) return undefined;
      const issuedAt = yield* Clock.currentTimeMillis;
      const threads = yield* runningThreads(match.instanceId);
      const [threadId] = threads;
      if (threads.length === 1 && threadId !== undefined) {
        const callerId = `hermes-t3-tools:${threadId}`;
        return {
          scope: {
            environmentId,
            capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
            issuedAt,
            requestNamespace: callerId,
            thread: {
              threadId,
              providerSessionId: callerId,
              providerInstanceId: match.instanceId,
            },
            client: undefined,
          },
          refusal: {},
        };
      }
      // Unbound: Hermes may still connect and list tools; every call is refused.
      return {
        scope: {
          environmentId,
          capabilities: new Set<McpInvocationContext.McpCapability>(),
          issuedAt,
          requestNamespace: `hermes-t3-tools:${match.instanceId}`,
          thread: undefined,
          client: undefined,
        },
        refusal: {
          unbound:
            threads.length === 0
              ? `T3 tools work only while a ${match.agentName} thread in T3 is running a turn.`
              : `Several ${match.agentName} threads are running in T3, so T3 can't tell which one is calling. Wait until only one is running.`,
        },
      };
    },
  );

  return HermesMcpBridge.of({ resolve });
});

export const layer = Layer.effect(HermesMcpBridge, make);

// What an unbound caller may still do: connect, list and stay connected.
const OPEN_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Verdict =
  | { readonly kind: "pass" }
  | { readonly kind: "tool"; readonly reason: string }
  | { readonly kind: "request"; readonly reason: string };

const PASS: Verdict = { kind: "pass" };

/** Whether one JSON-RPC message may reach the MCP server, and if not, how it is refused. */
const verdictOf = (message: unknown, refusal: HermesBridgeRefusal): Verdict => {
  // Unparseable bodies and JSON-RPC responses pass; the MCP server handles them.
  if (!isRecord(message) || typeof message.method !== "string") return PASS;
  const method = message.method;
  if (OPEN_METHODS.has(method) || method.startsWith("notifications/")) return PASS;
  if (refusal.unbound !== undefined) {
    return method === "tools/call"
      ? { kind: "tool", reason: refusal.unbound }
      : { kind: "request", reason: refusal.unbound };
  }
  if (method !== "tools/call") return PASS;
  const name = isRecord(message.params) ? message.params.name : undefined;
  if (typeof name === "string" && ALLOWED_TOOLS.has(name)) return PASS;
  const label = typeof name === "string" ? `"${name}"` : "That tool";
  return { kind: "tool", reason: `${label} is not one of the T3 tools Hermes may call.` };
};

/**
 * The response that refuses a bridged request, or undefined to let it
 * through. Hermes connects and lists tools when its gateway starts, long
 * before any T3 thread runs, so those always pass. An unbound caller's tool
 * call gets its refusal as a tool error the agent can read, and anything else
 * that would act gets a JSON-RPC error. A bound caller may call only
 * `HERMES_T3_TOOLS`. A batch is refused whole when any message in it would be.
 */
export const refuseUnboundRequest = Effect.fn("HermesMcpBridge.refuseUnboundRequest")(function* (
  request: HttpServerRequest.HttpServerRequest,
  refusal: HermesBridgeRefusal,
) {
  if (request.method !== "POST") return undefined;
  const body = yield* request.json.pipe(Effect.orElseSucceed(() => undefined));
  if (Array.isArray(body)) {
    const refused = body
      .map((message) => verdictOf(message, refusal))
      .find((verdict) => verdict.kind !== "pass");
    if (refused === undefined || refused.kind === "pass") return undefined;
    return HttpServerResponse.jsonUnsafe({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: refused.reason },
    });
  }
  const verdict = verdictOf(body, refusal);
  if (verdict.kind === "pass") return undefined;
  const id = isRecord(body) ? (body.id ?? null) : null;
  return HttpServerResponse.jsonUnsafe(
    verdict.kind === "tool"
      ? {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: verdict.reason }], isError: true },
        }
      : { jsonrpc: "2.0", id, error: { code: -32600, message: verdict.reason } },
  );
});
