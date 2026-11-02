/**
 * Where OpenBot runs: this server, or another machine reached over SSH. Every
 * openbot.db read and Local scripts call goes through here. On another machine
 * the token is read and used there, so it never crosses the wire.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

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

export type OpenBotLocation = Pick<OpenBotSettings, "configDir" | "sshHost">;
export type OpenBotRow = Record<string, unknown>;

export interface OpenBotQuery {
  readonly sql: string;
  readonly params?: ReadonlyArray<string | number>;
}

export interface OpenBotRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  /** JSON text. */
  readonly body?: string;
}

/** A Local scripts call's outcome: a response, no URL and token in `missing`, or no response. */
export type OpenBotReply =
  | { readonly status: number; readonly text: string }
  | { readonly missing: string }
  | { readonly failed: string };

const REQUEST_TIMEOUT_MS = 30_000;
const SSH_TIMEOUT_MS = REQUEST_TIMEOUT_MS + 15_000;
const SSH_HOST = /^[A-Za-z0-9_][A-Za-z0-9._@-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const defaultConfigDir = () => {
  const home = NodeOs.homedir();
  if (process.platform === "darwin")
    return NodePath.join(home, "Library", "Application Support", "OpenBot");
  if (process.platform === "win32")
    return NodePath.join(process.env.APPDATA || NodePath.join(home, "AppData", "Roaming"), "OpenBot");
  return NodePath.join(process.env.XDG_CONFIG_HOME || NodePath.join(home, ".config"), "OpenBot");
};

const localConfigDir = (configDir: string) => {
  if (!configDir) return defaultConfigDir();
  return configDir === "~" || configDir.startsWith("~/")
    ? NodePath.join(NodeOs.homedir(), configDir.slice(1))
    : configDir;
};

/** Where OpenBot's folder is, for messages. */
export const describeLocation = ({ configDir, sshHost }: OpenBotLocation) =>
  sshHost ? `${configDir || "OpenBot's default folder"} on ${sshHost}` : localConfigDir(configDir);

const headersFor = (token: string, body: string | undefined) => ({
  Accept: "application/json",
  Authorization: `Bearer ${token}`,
  ...(body === undefined ? {} : { "Content-Type": "application/json" }),
});

const replyHere = async (
  configDir: string,
  request: OpenBotRequest,
  signal: AbortSignal,
): Promise<OpenBotReply> => {
  const folder = NodePath.join(localConfigDir(configDir), "automation");
  let url: string;
  let token: string;
  try {
    [url, token] = (
      await Promise.all([
        NodeFs.readFile(NodePath.join(folder, "url"), "utf8"),
        NodeFs.readFile(NodePath.join(folder, "token"), "utf8"),
      ])
    ).map((value) => value.trim()) as [string, string];
  } catch {
    return { missing: folder };
  }
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}${request.path}`, {
      method: request.method,
      headers: headersFor(token, request.body),
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    return { status: response.status, text: await response.text() };
  } catch (cause) {
    return { failed: messageOf(cause) };
  }
};

// The same reads as above, run by the other machine's node. Keep the two in step.
const remoteScript = (input: {
  readonly configDir: string;
  readonly queries?: ReadonlyArray<OpenBotQuery>;
  readonly request?: OpenBotRequest;
}) => `import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const input = ${JSON.stringify(input)};
const home = os.homedir();
const fallback =
  process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "OpenBot")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "OpenBot")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "OpenBot");
const set = input.configDir;
const dir = !set ? fallback : set === "~" || set.startsWith("~/") ? path.join(home, set.slice(1)) : set;
const messageOf = (error) => (error instanceof Error ? error.message : String(error));
const reply = async () => {
  if (input.queries) {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(path.join(dir, "openbot.db"), { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout = 100");
        return { rows: input.queries.map((query) => db.prepare(query.sql).all(...(query.params ?? []))) };
      } finally {
        db.close();
      }
    } catch (error) {
      return { failed: messageOf(error) };
    }
  }
  const folder = path.join(dir, "automation");
  let url;
  let token;
  try {
    [url, token] = (
      await Promise.all([
        fs.readFile(path.join(folder, "url"), "utf8"),
        fs.readFile(path.join(folder, "token"), "utf8"),
      ])
    ).map((value) => value.trim());
  } catch {
    return { missing: folder };
  }
  const { method, path: route, body } = input.request;
  try {
    const response = await fetch(url.replace(/\\/+$/, "") + route, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(${REQUEST_TIMEOUT_MS}),
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    return { failed: messageOf(error) };
  }
};
process.stdout.write(JSON.stringify(await reply()));
`;

const sshOptions = () => [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  // A turn polls every couple of seconds; one shared connection keeps each poll cheap.
  ...(process.platform === "win32"
    ? []
    : [
        "-o",
        "ControlMaster=auto",
        "-o",
        `ControlPath=${NodePath.join(NodeOs.tmpdir(), "t3-openbot-%r@%h:%p")}`,
        "-o",
        "ControlPersist=60",
      ]),
];

/** Runs the reads on `sshHost` with its own node, and returns what the script printed. */
const runOver = (sshHost: string, input: Parameters<typeof remoteScript>[0]) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<unknown>((resolve, reject) => {
        if (!SSH_HOST.test(sshHost)) {
          reject(new Error(`"${sshHost}" is not an SSH host name.`));
          return;
        }
        const child = NodeChildProcess.execFile(
          process.platform === "win32" ? "ssh.exe" : "ssh",
          [...sshOptions(), sshHost, "node", "--input-type=module", "-"],
          { signal, timeout: SSH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(stderr.trim().split("\n").at(-1) || error.message));
              return;
            }
            try {
              resolve(JSON.parse(stdout) as unknown);
            } catch {
              reject(new Error("its reply was not JSON. Is node 22.13 or newer installed there?"));
            }
          },
        );
        child.stdin?.end(remoteScript(input));
      }),
    catch: (cause) =>
      new OpenBotError({ detail: `Could not reach OpenBot on ${sshHost} over SSH: ${messageOf(cause)}` }),
  });

const readFailure = (location: OpenBotLocation, reason: string) =>
  new OpenBotError({
    detail: `Could not read OpenBot's conversations in ${describeLocation(location)}: ${reason}`,
  });

/** Read-only queries against openbot.db, all in one connection; one row list per query. */
export const query = (
  location: OpenBotLocation,
  queries: ReadonlyArray<OpenBotQuery>,
): Effect.Effect<ReadonlyArray<ReadonlyArray<OpenBotRow>>, OpenBotError> => {
  if (location.sshHost)
    return runOver(location.sshHost, { configDir: location.configDir, queries }).pipe(
      Effect.flatMap((reply) =>
        isRecord(reply) && Array.isArray(reply.rows)
          ? Effect.succeed(
              reply.rows.map((rows: unknown) => (Array.isArray(rows) ? rows.filter(isRecord) : [])),
            )
          : Effect.fail(
              readFailure(
                location,
                isRecord(reply) && typeof reply.failed === "string" ? reply.failed : "no rows came back",
              ),
            ),
      ),
    );
  return Effect.try({
    try: () => {
      const db = new NodeSqlite.DatabaseSync(
        NodePath.join(localConfigDir(location.configDir), "openbot.db"),
        { readOnly: true },
      );
      try {
        // OpenBot owns the writer; never wait on it.
        db.exec("PRAGMA busy_timeout = 100");
        return queries.map((each) => db.prepare(each.sql).all(...(each.params ?? [])));
      } finally {
        db.close();
      }
    },
    catch: (cause) => readFailure(location, messageOf(cause)),
  });
};

const decodeReply = (reply: unknown): OpenBotReply => {
  if (isRecord(reply)) {
    if (typeof reply.status === "number" && typeof reply.text === "string")
      return { status: reply.status, text: reply.text };
    if (typeof reply.missing === "string") return { missing: reply.missing };
    if (typeof reply.failed === "string") return { failed: reply.failed };
  }
  return { failed: "an unreadable reply came back" };
};

/** One Local scripts call, with the URL and token OpenBot wrote most recently. */
export const call = (
  location: OpenBotLocation,
  request: OpenBotRequest,
): Effect.Effect<OpenBotReply, OpenBotError> =>
  location.sshHost
    ? runOver(location.sshHost, { configDir: location.configDir, request }).pipe(
        Effect.map(decodeReply),
      )
    : Effect.promise((signal) => replyHere(location.configDir, request, signal));
