import { AuthMcpClientAccess, mcpClientScopes, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import { runAcpMcpStdioBridge } from "../mcp/AcpMcpStdioBridge.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  resolveCliAuthConfig,
} from "./config.ts";

const runWithMcpSessions = Effect.fn("cli.mcp.runWithMcpSessions")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: (sessions: SessionStore.SessionStore["Service"]) => Effect.Effect<A, E>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    return yield* run(sessions);
  }).pipe(
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
      ),
    ),
  );
});

const tokenCommand = Command.make("token", {
  ...authLocationFlags,
  name: Flag.String("name").pipe(
    Flag.withSchema(TrimmedNonEmptyString),
    Flag.withDescription("Name shown for this agent in Sharing & access."),
  ),
  access: Flag.Literals("access", [...AuthMcpClientAccess.literals, "supervised"]).pipe(
    Flag.withDescription("Access level; supervised is an alias for approval-required."),
  ),
  ttl: Flag.String("ttl").pipe(
    Flag.withSchema(
      DurationFromString.pipe(
        Schema.check(
          Schema.makeFilter(
            (duration) =>
              Number.isFinite(Duration.toMillis(duration)) && Duration.toMillis(duration) > 0,
            { expected: "a finite, positive duration" },
          ),
        ),
      ),
    ),
    Flag.withDefault(Duration.days(30)),
    Flag.withDescription("Token lifetime, for example 1h or 30d (default: 30d)."),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Emit the token and session metadata as JSON."),
  ),
}).pipe(
  Command.withDescription("Issue a revocable MCP client token with an explicit access level."),
  Command.withHandler((flags) =>
    runWithMcpSessions(flags, (sessions) =>
      Effect.gen(function* () {
        const access = flags.access === "supervised" ? "approval-required" : flags.access;
        // OAuth uses this same store and grant shape, but its issuer fixes the TTL at 30 days.
        const issued = yield* sessions.issue({
          subject: "mcp-client",
          method: "bearer-access-token",
          scopes: mcpClientScopes(access),
          ttl: flags.ttl,
          ...(access === "read-only" ? {} : { runtimeModeCeiling: access }),
          peerLink: false,
          client: { label: flags.name, deviceType: "bot" },
        });
        yield* Console.error(
          `MCP client session: ${issued.sessionId}\nRevoke in Settings → Sharing & access, or run t3 auth session revoke ${issued.sessionId} against the same environment.`,
        );
        yield* Console.log(
          flags.json
            ? JSON.stringify({
                token: issued.token,
                sessionId: issued.sessionId,
                name: flags.name,
                access,
                expiresAt: DateTime.formatIso(issued.expiresAt),
              })
            : issued.token,
        );
      }),
    ),
  ),
);

const stdioCommand = Command.make("stdio", {
  ...authLocationFlags,
  url: Flag.String("url").pipe(
    Flag.withSchema(
      Schema.URLFromString.pipe(
        Schema.check(
          Schema.makeFilter(
            (url) =>
              (url.protocol === "http:" || url.protocol === "https:") &&
              url.username === "" &&
              url.password === "" &&
              url.search === "" &&
              url.hash === "",
            { expected: "an HTTP(S) MCP URL without credentials, a query, or a fragment" },
          ),
        ),
      ),
    ),
    Flag.withDescription("MCP URL; defaults to the local environment's own address."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Bridge MCP to stdio using the token in T3_MCP_TOKEN."),
  Command.withHandler(
    Effect.fn("cli.mcp.stdio")(
      function* (flags) {
        const secret = yield* Config.Redacted("T3_MCP_TOKEN");
        const token = Redacted.value(secret).trim();
        if (token.length === 0 || /\s/.test(token)) {
          return yield* new CliError.UserError({
            cause: "T3_MCP_TOKEN must contain a bearer token without the Bearer prefix.",
          });
        }
        let endpoint: string;
        if (Option.isSome(flags.url)) {
          endpoint = flags.url.value.href;
        } else {
          const logLevel = yield* GlobalFlag.LogLevel;
          const config = yield* resolveCliAuthConfig(flags, logLevel);
          const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
          if (Option.isNone(runtime)) {
            return yield* new CliError.UserError({
              cause: "No local environment runtime was found. Start the environment or pass --url.",
            });
          }
          endpoint = new URL("/mcp", runtime.value.origin).href;
        }
        return yield* runAcpMcpStdioBridge({
          endpoint,
          authorization: `Bearer ${token}`,
          input: process.stdin,
          output: process.stdout,
        });
      },
      Effect.provideService(References.MinimumLogLevel, "None"),
    ),
  ),
);

export const mcpCommand = Command.make("mcp").pipe(
  Command.withDescription("Connect outside agents through this environment's MCP server."),
  Command.withSubcommands([tokenCommand, stdioCommand]),
);
