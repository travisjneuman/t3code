// Fork add-on(fleet-service-updates): runs the service updaters listed in the private hosts.json
// `services` array. Each updater owns its own idle gate, lock and restart, and prints one JSON line
// `{state, from, to, detail}` last on stdout, with state updated | current | held | failed.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { powershellArgs, psQuote, record, requireState, shellQuote, type Host } from "./remote.ts";

type State = "updated" | "current" | "held" | "failed";
interface Service {
  name: string;
  host: string | null;
  after?: string;
  command: string[];
}
interface Outcome {
  name: string;
  state: State;
  from: string | null;
  to: string | null;
  detail: string | null;
}

// Updaters wait up to 20 minutes for their service to go idle before they hold.
const SERVICE_TIMEOUT_MS = 45 * 60 * 1000;
const STATES: readonly string[] = ["updated", "current", "held", "failed"];
const line = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !/[\r\n\0]/.test(value);

export function services(raw: unknown, hosts: Record<string, Host>): Service[] {
  if (raw === undefined) return [];
  requireState(Array.isArray(raw), "services must be an array.");
  const seen = new Set<string>();
  return raw.map((entry: unknown) => {
    requireState(
      record(entry) &&
        line(entry.name) &&
        !seen.has(entry.name) &&
        (entry.host === null || (line(entry.host) && Object.hasOwn(hosts, entry.host))) &&
        (entry.after === undefined || (line(entry.after) && seen.has(entry.after))) &&
        Array.isArray(entry.command) &&
        entry.command.length > 0 &&
        entry.command.every(line),
      "Each service needs a unique name, a configured host or null, an earlier `after` " +
        "and a command argv.",
    );
    seen.add(entry.name);
    return entry as unknown as Service;
  });
}

function argv(service: Service, hosts: Record<string, Host>): [string, string[]] {
  if (service.host === null) return [service.command[0]!, service.command.slice(1)];
  const host = hosts[service.host]!;
  const remote =
    host.os === "win32"
      ? [
          "powershell.exe",
          ...powershellArgs(`& ${service.command.map(psQuote).join(" ")}\nexit $LASTEXITCODE`),
        ].join(" ")
      : service.command.map(shellQuote).join(" ");
  return [
    "ssh",
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      host.ssh,
      remote,
    ],
  ];
}

function outcome(name: string, stdout: string, code: number | null): Outcome {
  for (const text of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      const value: unknown = JSON.parse(text);
      if (record(value) && typeof value.state === "string" && STATES.includes(value.state)) {
        const field = (key: string) => {
          const item = value[key];
          return typeof item === "string" ? item : null;
        };
        const state = value.state as State;
        return { name, state, from: field("from"), to: field("to"), detail: field("detail") };
      }
    } catch {
      // Not the result line.
    }
  }
  const detail = `The updater exited ${code ?? "on a signal"} without a result.`;
  return { name, state: "failed", from: null, to: null, detail };
}

function runService(service: Service, hosts: Record<string, Host>): Promise<Outcome> {
  const [command, args] = argv(service, hosts);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-65_536);
    });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[${service.name}] ${chunk}`));
    const timer = setTimeout(() => child.kill("SIGTERM"), SERVICE_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ name: service.name, state: "failed", from: null, to: null, detail: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(outcome(service.name, stdout, code));
    });
  });
}

export async function servicesUpdate(
  list: Service[],
  hosts: Record<string, Host>,
  resultFile: string,
) {
  if (list.length === 0) {
    console.log("No services are configured in hosts.json.");
    return 0;
  }
  const started = new Map<string, Promise<Outcome>>();
  for (const service of list) {
    const before = service.after === undefined ? undefined : started.get(service.after)!;
    started.set(
      service.name,
      (async () => {
        const dependency = before === undefined ? undefined : await before;
        if (dependency && dependency.state !== "updated" && dependency.state !== "current") {
          const detail = `Waits for ${dependency.name}, which is ${dependency.state}.`;
          const held: Outcome = { name: service.name, state: "held", from: null, to: null, detail };
          return held;
        }
        return runService(service, hosts);
      })(),
    );
  }
  const outcomes = await Promise.all(started.values());
  for (const item of outcomes) {
    const versions = item.from || item.to ? ` (${item.from ?? "?"} -> ${item.to ?? "?"})` : "";
    console.log(`${item.name}: ${item.state}${versions}${item.detail ? ` - ${item.detail}` : ""}`);
  }
  await fs.mkdir(path.dirname(resultFile), { recursive: true });
  const body = { finishedAt: new Date().toISOString(), services: outcomes };
  await fs.writeFile(`${resultFile}.tmp`, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(`${resultFile}.tmp`, resultFile);
  if (outcomes.some((item) => item.state === "failed")) return 1;
  return outcomes.some((item) => item.state === "held") ? 3 : 0;
}
