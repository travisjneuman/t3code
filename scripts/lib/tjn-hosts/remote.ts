// Fork add-on: host maintenance never opens the live database for writing.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { compareSemverVersions } from "@t3tools/shared/semver";

export interface Host {
  ssh: string;
  os: "win32" | "linux";
  checkout: string;
  t3Home: string;
  cacheDir: string;
  node: string[];
  env: Record<string, string>;
  loginShell: boolean;
  service:
    | { kind: "task"; name: string; file: string }
    | { kind: "systemd"; unit: string; file: string };
}
export interface HostConfig {
  version: 1;
  hosts: Record<string, Host>;
  buildHosts: Record<"win32-x64" | "linux-x64", string[]>;
}
export interface State {
  protocol: 3;
  activeVersion: string;
  update?: {
    id: string;
    fromVersion: string;
    targetVersion: string;
    status: string;
    dbPath?: string;
  };
}
interface Runtime {
  version: number;
  pid: number;
  serverVersion: string;
  serviceManaged: boolean;
  startedAt: string;
}
export interface Snapshot {
  state: State;
  runtime: Runtime | null;
  serviceStatus: string;
  serviceFileSha256: string;
  versions: string[];
  launcherVersion: string;
  launcherDirectory: string;
  releaseBaseUrlSet: boolean;
  backups: string[];
  backupVersions: Record<string, string>;
  environmentId: string;
}
export interface Request {
  host: Host;
  action: "ready" | "inspect" | "build" | "remove-cache" | "prune" | "rollback";
  version?: string;
  sha?: string;
  expected?: Snapshot;
  migrationsUnchanged?: boolean;
  confirmIdle?: boolean;
}
export class Refusal extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 3) {
    super(message);
    this.exitCode = exitCode;
  }
}
export function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Refusal(message);
  }
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function version(value: unknown): string {
  requireState(
    typeof value === "string" &&
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.\d{8}\.(0|[1-9]\d*))?$/.test(value),
    "Unsupported version; expected an exact stable or nightly version.",
  );
  requireState(
    value
      .split(/[.-]/)
      .filter((part) => /^\d+$/.test(part))
      .every((part) => Number.isSafeInteger(Number(part))),
    "Version has a numeric identifier outside the supported integer range.",
  );
  return value;
}
export function compareVersions(a: string, b: string): number {
  return compareSemverVersions(version(a), version(b));
}
export const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`;
export const powershellArgs = (script: string) => [
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(`$ErrorActionPreference='Stop'\n${script}`, "utf16le").toString("base64"),
];

export async function run(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; log?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const log = options.log ? await fs.open(options.log, "ax", 0o600) : undefined;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["pipe", log?.fd ?? "pipe", log?.fd ?? "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let oversized = false;
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) {
          oversized = true;
        } else {
          stdout += chunk;
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-16_384);
      });
      child.on("error", reject);
      child.stdin!.on("error", () => {
        // Exit status below is authoritative if the remote closes stdin.
      });
      child.on("close", (code) => {
        if (code !== 0) {
          const exitCode = code !== null && [1, 2, 3, 4, 255].includes(code) ? code : 1;
          reject(
            new Refusal(
              `${path.basename(command)} exited ${code ?? "without an exit code"}.${stderr ? `\n${stderr.trim()}` : ""}`,
              exitCode,
            ),
          );
        } else if (oversized) {
          reject(
            new Refusal(
              "Command output exceeded the bounded capture; refusing incomplete output.",
              1,
            ),
          );
        } else {
          resolve(stdout.trim());
        }
      });
      child.stdin!.end(options.input);
    });
  } finally {
    await log?.close();
  }
}
export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
async function exists(file: string) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
async function realDirectory(dir: string) {
  const stat = await fs.lstat(dir);
  requireState(
    stat.isDirectory() && !stat.isSymbolicLink(),
    "Expected a real directory, not a link or other file.",
  );
  requireState(
    path.resolve(await fs.realpath(dir)) === path.resolve(dir),
    "A configured directory traverses a link; refusing mutation.",
  );
}
async function plainFile(file: string) {
  const stat = await fs.lstat(file);
  requireState(
    stat.isFile() && !stat.isSymbolicLink(),
    "Expected a regular file, not a link or other file.",
  );
}
async function mutableFile(file: string) {
  await plainFile(file);
  requireState(
    (await fs.stat(file)).nlink === 1 &&
      path.resolve(await fs.realpath(file)) === path.resolve(file),
    "Refusing a linked maintenance file.",
  );
}
async function cacheRoot(host: Host) {
  if (!(await exists(host.cacheDir))) {
    await realDirectory(path.dirname(host.cacheDir));
    await fs.mkdir(host.cacheDir, { mode: 0o700 });
  }
  await realDirectory(host.cacheDir);
}
async function json(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
function decodeState(value: unknown): State {
  requireState(record(value) && value.protocol === 3, "Unsupported service-state protocol.");
  const activeVersion = version(value.activeVersion);
  if (value.update !== undefined) {
    const u = value.update;
    requireState(
      record(u) && typeof u.id === "string" && u.id.length > 0,
      "Invalid service update record.",
    );
    version(u.fromVersion);
    version(u.targetVersion);
    requireState(
      compareVersions(String(u.targetVersion), String(u.fromVersion)) > 0,
      "Invalid service update version order.",
    );
    requireState(
      ["pending", "committed", "rolled-back", "failed"].includes(String(u.status)),
      "Unknown service update status.",
    );
    requireState(
      u.status !== "pending" || (typeof u.dbPath === "string" && u.dbPath.length > 0),
      "Pending service update has no database path.",
    );
    requireState(
      (u.status === "committed" ? u.targetVersion : u.fromVersion) === activeVersion,
      "Service state and update record disagree.",
    );
  }
  return value as unknown as State;
}
const runtimePath = (host: Host) => path.join(host.t3Home, "userdata", "server-runtime.json");
const statePath = (host: Host) => path.join(host.t3Home, "runtime", "service-state.json");
const versionsPath = (host: Host) => path.join(host.t3Home, "runtime", "versions");
const backupRoot = (host: Host) => path.join(host.t3Home, "backups");
const executable = (host: Host, v: string) =>
  path.join(versionsPath(host), version(v), host.os === "win32" ? "t3.exe" : "t3");
async function installed(host: Host, v: string) {
  await realDirectory(path.join(versionsPath(host), version(v)));
  await plainFile(executable(host, v));
  const sentinel = path.join(versionsPath(host), v, ".install-complete");
  await plainFile(sentinel);
  requireState(
    (await fs.readFile(sentinel, "utf8")).trim() === v,
    "Installed version is incomplete or has the wrong sentinel.",
  );
}
async function readRuntime(host: Host): Promise<Runtime> {
  const value = await json(runtimePath(host));
  requireState(
    record(value) &&
      value.version === 1 &&
      Number.isSafeInteger(value.pid) &&
      Number(value.pid) > 0 &&
      value.serviceManaged === true &&
      typeof value.startedAt === "string",
    "Expected a service-managed server-runtime record with a positive pid.",
  );
  version(value.serverVersion);
  requireState(Number.isFinite(Date.parse(value.startedAt)), "Runtime start time is invalid.");
  return value as unknown as Runtime;
}
async function serviceStatus(host: Host) {
  if (host.service.kind === "systemd") {
    return run("systemctl", [
      "--user",
      "show",
      host.service.unit,
      "--property=ActiveState",
      "--value",
    ]);
  }
  return run(
    "powershell.exe",
    powershellArgs(`(Get-ScheduledTask -TaskName ${psQuote(host.service.name)}).State.ToString()`),
  );
}
function launcher(contents: string, host: Host) {
  const pattern =
    host.os === "win32"
      ? /"([^"\r\n]+\\t3\.exe)"\s+__service-launcher/g
      : /^ExecStart=(?:"([^"\r\n]+)"|([^\s"\r\n]+))\s+__service-launcher\s*$/gm;
  const matches = [...contents.matchAll(pattern)];
  requireState(
    matches.length === 1,
    "Service file must name exactly one quoted Windows launcher or one standalone systemd launcher.",
  );
  const match = matches[0]!;
  const entry = match[1] ?? match[2]!;
  const v = version(path.basename(path.dirname(entry)));
  const same = (a: string, b: string) =>
    host.os === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  requireState(
    same(path.normalize(entry), executable(host, v)),
    "Service launcher is outside the configured versions directory.",
  );
  return { entry, version: v };
}
async function names(dir: string): Promise<string[]> {
  if (!(await exists(dir))) {
    return [];
  }
  await realDirectory(dir);
  return (await fs.readdir(dir)).sort();
}
async function inspect(host: Host): Promise<Snapshot> {
  const state = decodeState(await json(statePath(host)));
  const runtime = (await exists(runtimePath(host))) ? await readRuntime(host) : null;
  const file = await fs.readFile(host.service.file, "utf8");
  const named = launcher(file, host);
  const backups = await names(backupRoot(host));
  const backupVersions: Record<string, string> = {};
  for (const name of backups) {
    const savedState = path.join(backupRoot(host), name, "service-state.json");
    if (await exists(savedState)) {
      const saved = decodeState(await json(savedState));
      backupVersions[name] = saved.activeVersion;
    }
  }
  return {
    state,
    runtime,
    serviceStatus: await serviceStatus(host),
    serviceFileSha256: createHash("sha256").update(file).digest("hex"),
    versions: await names(versionsPath(host)),
    launcherVersion: named.version,
    launcherDirectory: path.dirname(named.entry),
    releaseBaseUrlSet: /^\s*(?:set\s+"?|Environment="?)T3CODE_RELEASE_BASE_URL=/im.test(file),
    backups,
    backupVersions,
    environmentId: (
      await fs.readFile(path.join(host.t3Home, "userdata", "environment-id"), "utf8")
    ).trim(),
  };
}
function running(
  snapshot: Snapshot,
  host: Host,
): asserts snapshot is Snapshot & { runtime: Runtime } {
  requireState(
    snapshot.state.update?.status !== "pending",
    "A service update is pending; no maintenance is allowed.",
  );
  requireState(
    snapshot.serviceStatus.toLowerCase() === (host.os === "win32" ? "running" : "active"),
    "Service is not running; refusing maintenance.",
  );
  requireState(
    snapshot.runtime !== null && snapshot.runtime.serverVersion === snapshot.state.activeVersion,
    "Runtime is absent or its version differs from activeVersion.",
  );
  requireState(snapshot.environmentId.length > 0, "Missing environment identity.");
}
function unchanged(before: Snapshot, now: Snapshot) {
  requireState(
    JSON.stringify(before) === JSON.stringify(now),
    "Host state changed since preflight; nothing was stopped.",
  );
}
async function unchangedAfterStop(host: Host, before: Snapshot) {
  // A clean shutdown may remove server-runtime.json; the durable baseline is authoritative here.
  await mutableFile(statePath(host));
  await mutableFile(host.service.file);
  const state = decodeState(await json(statePath(host)));
  const service = await fs.readFile(host.service.file, "utf8");
  const environmentId = (
    await fs.readFile(path.join(host.t3Home, "userdata", "environment-id"), "utf8")
  ).trim();
  requireState(
    state.update?.status !== "pending" && JSON.stringify(state) === JSON.stringify(before.state),
    "Service state changed while stopped or an update is pending; service-file/state writes were refused.",
  );
  requireState(
    createHash("sha256").update(service).digest("hex") === before.serviceFileSha256 &&
      environmentId === before.environmentId,
    "Service content or environment identity changed while stopped; service-file/state writes were refused.",
  );
  requireState(
    !(await exists(path.join(host.t3Home, "runtime", ".service-state.host-maintenance"))),
    "A maintenance transition appeared while stopped; service-file/state writes were refused.",
  );
  requireState(
    (await serviceStatus(host)).toLowerCase() === (host.os === "win32" ? "ready" : "inactive"),
    "Service is no longer stopped; service-file/state writes were refused.",
  );
}
async function stop(host: Host, before: Snapshot & { runtime: Runtime }) {
  if (host.service.kind === "systemd") {
    const mainPid = Number(
      await run("systemctl", [
        "--user",
        "show",
        host.service.unit,
        "--property=MainPID",
        "--value",
      ]),
    );
    requireState(Number.isSafeInteger(mainPid) && mainPid > 0, "systemd has no launcher PID.");
    const fragment = await run("systemctl", [
      "--user",
      "show",
      host.service.unit,
      "--property=FragmentPath",
      "--value",
    ]);
    requireState(fragment === host.service.file, "systemd loaded a different service file.");
    requireState(
      (await fs.readlink(`/proc/${mainPid}/exe`)) === executable(host, before.launcherVersion),
      "systemd MainPID is not the configured launcher.",
    );
    requireState(
      (await fs.readlink(`/proc/${before.runtime.pid}/exe`)) ===
        executable(host, before.state.activeVersion),
      "Runtime PID is not the active executable.",
    );
    const stat = await fs.readFile(`/proc/${before.runtime.pid}/stat`, "utf8");
    requireState(
      Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === mainPid,
      "Runtime PID is not the service launcher's child.",
    );
    await run("systemctl", ["--user", "stop", host.service.unit]);
  } else {
    // Never search for processes by name: the only root is the persisted server PID.
    const script = `
$server = Get-CimInstance Win32_Process -Filter "ProcessId = ${before.runtime.pid}"
if (!$server -or $server.ExecutablePath -ine ${psQuote(executable(host, before.state.activeVersion))}) {
  throw 'Runtime PID does not own the expected executable'
}
if ($server.CreationDate -gt [datetime]${psQuote(before.runtime.startedAt)}) {
  throw 'Runtime PID was reused after its record was written'
}
$p = $server
$seen = @{}
$console = $null
for ($i=0; $i -lt 32; $i++) {
  if (!$p -or $seen.ContainsKey([string]$p.ProcessId)) {
    throw 'Broken process ancestry'
  }
  $seen[[string]$p.ProcessId] = $true
  if ($p.Name -ieq 'conhost.exe') {
    $console = $p
    break
  }
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)"
  if ($parent -and $parent.CreationDate -gt $p.CreationDate) {
    throw 'Reused parent PID'
  }
  $p = $parent
}
if (!$console -or !$console.CommandLine -or !$console.CommandLine.Contains(${psQuote(host.service.file)})) {
  throw 'No task-owned conhost ancestor'
}
$task = Get-ScheduledTask -TaskName ${psQuote(host.service.name)}
if ($task.Actions.Count -ne 1 -or !$task.Actions[0].Arguments -or !$task.Actions[0].Arguments.Contains(${psQuote(host.service.file)})) {
  throw 'Task action does not name the configured service file'
}
$descendants = @($seen.Keys | ForEach-Object { [int]$_ })
& taskkill.exe /PID $console.ProcessId /T /F
if ($LASTEXITCODE -ne 0) {
  throw 'taskkill failed'
}
& schtasks.exe /end /tn ${psQuote(host.service.name)}
if ($LASTEXITCODE -ne 0) {
  throw 'schtasks end failed'
}
foreach ($processId in $descendants) {
  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
    throw 'Service process remains alive'
  }
}
`;
    await run("powershell.exe", powershellArgs(script));
  }
  const status = (await serviceStatus(host)).toLowerCase();
  requireState(
    status === (host.os === "win32" ? "ready" : "inactive"),
    "Service did not stop; no files were changed.",
  );
  try {
    process.kill(before.runtime.pid, 0);
    throw new Refusal("Server PID is still alive; no files were changed.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}
async function start(host: Host) {
  if (host.service.kind === "systemd") {
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "start", host.service.unit]);
  } else {
    await run("schtasks.exe", ["/run", "/tn", host.service.name]);
  }
}
async function verifyRestart(host: Host, before: Snapshot & { runtime: Runtime }, target: string) {
  // One bounded startup window, not a recurring monitor or a repair/restart loop.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const now = await inspect(host);
      requireState(
        now.state.activeVersion === target,
        "activeVersion changed unexpectedly after restart; no pruning was performed.",
      );
      requireState(
        now.state.update?.status !== "pending",
        "An update began during restart; no pruning was performed.",
      );
      requireState(
        now.environmentId === before.environmentId,
        "Environment identity changed after restart.",
      );
      requireState(
        now.launcherVersion === target,
        "Service file no longer names the requested launcher.",
      );
      const isRunning =
        now.serviceStatus.toLowerCase() === (host.os === "win32" ? "running" : "active");
      if (
        isRunning &&
        now.runtime?.serverVersion === target &&
        now.runtime.pid !== before.runtime.pid &&
        now.runtime.startedAt !== before.runtime.startedAt
      ) {
        return now;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Refusal(
    "Restart was requested, but the expected version was not confirmed within 60 seconds; no pruning was performed.",
    4,
  );
}
async function validateBackup(host: Host, name: string, before: Snapshot) {
  const dir = path.join(backupRoot(host), name);
  await realDirectory(dir);
  const cold = /^cold-(.+?)(?:-\d{8}T\d{9}Z)?$/.exec(name);
  const preFork = /^pre-fork-(?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(name);
  requireState(cold || preFork, "Unrecognized backup directory; refusing retention.");
  const saved = decodeState(await json(path.join(dir, "service-state.json")));
  requireState(
    saved.update?.status !== "pending",
    "Cold backup records a pending update; refusing retention.",
  );
  requireState(
    compareVersions(saved.activeVersion, before.state.activeVersion) <= 0,
    "A backup is newer than activeVersion; refusing retention.",
  );
  const serviceFile = cold
    ? host.os === "win32"
      ? "service.cmd"
      : "service.unit"
    : path.basename(host.service.file);
  const required = ["statev2.sqlite", "service-state.json", serviceFile];
  const allowed = new Set([
    ...required,
    "statev2.sqlite-wal",
    "statev2.sqlite-shm",
    ...(cold ? ["backup.json"] : []),
  ]);
  const entries = await fs.readdir(dir);
  requireState(
    entries.every((entry) => allowed.has(entry)),
    "Cold backup contains unrecognized files; refusing retention.",
  );
  for (const entry of new Set([...required, ...entries])) {
    await plainFile(path.join(dir, entry));
  }
  if (cold) {
    requireState(
      version(cold[1]) === saved.activeVersion,
      "Cold backup directory and service state versions disagree.",
    );
    const manifest = await json(path.join(dir, "backup.json"));
    requireState(
      record(manifest) &&
        manifest.complete === true &&
        manifest.version === saved.activeVersion &&
        manifest.environmentId === before.environmentId,
      "Cold backup is incomplete or belongs to another environment.",
    );
    if (manifest.files !== undefined) {
      requireState(record(manifest.files), "Cold backup file receipt is malformed.");
      const files = manifest.files;
      requireState(
        entries
          .filter((entry) => entry !== "backup.json")
          .every((entry) => Object.hasOwn(files, entry)),
        "Cold backup receipt omits a file.",
      );
      for (const [entry, hash] of Object.entries(files)) {
        requireState(
          entry !== "backup.json" &&
            allowed.has(entry) &&
            typeof hash === "string" &&
            /^[a-f0-9]{64}$/.test(hash),
          "Cold backup file receipt is invalid.",
        );
        requireState(
          (await hashFile(path.join(dir, entry))) === hash,
          "Cold backup file checksum mismatch; refusing retention.",
        );
      }
    }
  }
  return saved.activeVersion;
}

async function backup(host: Host, before: Snapshot) {
  const root = backupRoot(host);
  if (!(await exists(root))) {
    await fs.mkdir(root, { mode: 0o700 });
  }
  await realDirectory(root);
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[-:.]/g, "");
  const dir = path.join(root, `cold-${version(before.state.activeVersion)}-${stamp}`);
  // Always capture the current stopped state, not an older same-version recovery point.
  await fs.mkdir(dir, { mode: 0o700 });
  const files: Record<string, string> = {};
  const copy = async (source: string, name: string) => {
    await plainFile(source);
    const destination = path.join(dir, name);
    await fs.copyFile(source, destination);
    const handle = await fs.open(destination, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    files[name] = await hashFile(destination);
    requireState(
      files[name] === (await hashFile(source)),
      "Cold backup differs from its stopped source; no service or version files were changed.",
    );
  };
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = path.join(host.t3Home, "userdata", `statev2.sqlite${suffix}`);
    if (suffix && !(await exists(source))) {
      continue;
    }
    await copy(source, `statev2.sqlite${suffix}`);
  }
  await copy(statePath(host), "service-state.json");
  await copy(host.service.file, host.os === "win32" ? "service.cmd" : "service.unit");
  const manifest = {
    version: before.state.activeVersion,
    environmentId: before.environmentId,
    complete: true,
    createdAt,
    files,
  };
  await fs.writeFile(path.join(dir, "backup.json"), JSON.stringify(manifest) + "\n", {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  if (host.os !== "win32") {
    for (const directory of [dir, root]) {
      const handle = await fs.open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  await validateBackup(host, path.basename(dir), before);
  return dir;
}
async function rewrittenService(host: Host, target: string, upstream: boolean) {
  const old = await fs.readFile(host.service.file, "utf8");
  const named = launcher(old, host);
  const nextEntry = executable(host, target);
  requireState(
    !/["%$!\r\n]/.test(nextEntry),
    "Launcher path contains unsupported service-file metacharacters.",
  );
  let next = old.replace(named.entry, nextEntry);
  if (upstream) {
    const lines = next.split(/(?<=\n)/);
    next = lines
      .filter((line) => {
        // cmd environment names are case-insensitive; systemd's are not.
        if (
          !(host.os === "win32" ? /T3CODE_RELEASE_BASE_URL/i : /T3CODE_RELEASE_BASE_URL/).test(line)
        ) {
          return true;
        }
        requireState(
          /^(?:set\s+"?T3CODE_RELEASE_BASE_URL=https:\/\/github\.com\/travisjneuman\/t3code\/releases\/download"?|Environment="?T3CODE_RELEASE_BASE_URL=https:\/\/github\.com\/travisjneuman\/t3code\/releases\/download"?)\s*$/i.test(
            line.trim(),
          ),
          "Release-base environment line is not a standalone fork URL; refusing to rewrite it.",
        );
        return false;
      })
      .join("");
  }
  requireState(launcher(next, host).version === target, "Rewritten service launcher is ambiguous.");
  return next;
}
async function downloadUpstream(host: Host, target: string) {
  const dir = path.join(versionsPath(host), target);
  if (await exists(dir)) {
    await installed(host, target);
    return false;
  }
  const cache = path.join(host.cacheDir, target);
  requireState(
    !(await exists(cache)),
    "Rollback cache already exists; refusing to reuse or overwrite it.",
  );
  const cacheFilesystem = (await exists(host.cacheDir))
    ? host.cacheDir
    : path.dirname(host.cacheDir);
  await realDirectory(cacheFilesystem);
  await realDirectory(versionsPath(host));
  const sameFilesystem =
    (await fs.stat(cacheFilesystem, { bigint: true })).dev ===
    (await fs.stat(versionsPath(host), { bigint: true })).dev;
  await cacheRoot(host);
  await fs.mkdir(cache, { mode: 0o700 });
  await realDirectory(cache);
  const platform = `${host.os}-x64`;
  const name = `t3-${target}-${platform}.${host.os === "win32" ? "zip" : "tar.gz"}`;
  const base = `https://github.com/pingdotgg/t3code/releases/download/v${target}`;
  const sums = await fetch(`${base}/SHA256SUMS`, { signal: AbortSignal.timeout(60_000) });
  requireState(sums.ok, "Upstream checksums are unavailable; fix forward instead.");
  const matches = (await sums.text())
    .split(/\r?\n/)
    .filter((line) => line.trim().endsWith(` ${name}`));
  requireState(
    matches.length === 1 && /^[a-f0-9]{64}  /.test(matches[0]!),
    "Missing or ambiguous upstream checksum.",
  );
  const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(600_000) });
  requireState(
    response.ok && response.body !== null,
    "Upstream archive is unavailable; fix forward instead.",
  );
  const archive = path.join(cache, name);
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(archive, { flags: "wx", mode: 0o600 }),
  );
  requireState(
    (await hashFile(archive)) === matches[0]!.slice(0, 64),
    "Upstream archive checksum mismatch.",
  );
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  requireState(host.os !== "win32" || systemRoot, "Windows system tar location is unavailable.");
  const tar = host.os === "win32" ? path.join(systemRoot!, "System32", "tar.exe") : "tar";
  const entries = (await run(tar, ["-tf", archive])).split(/\r?\n/);
  const stem = name.replace(/\.(zip|tar\.gz)$/, "");
  requireState(
    entries.every(
      (entry) =>
        entry.startsWith(`${stem}/`) &&
        !entry.split(/[\\/]/).includes("..") &&
        !entry.includes("\\") &&
        !entry.includes(":"),
    ),
    "Unexpected upstream archive layout.",
  );
  const listing = (await run(tar, ["-tvf", archive])).split(/\r?\n/);
  requireState(
    listing.every((entry) => /^[d-]/.test(entry)),
    "Archive contains links or special files; refusing extraction.",
  );
  // Extract in the named cache first; no incomplete runtime is made active.
  const extracted = path.join(cache, "extracted");
  await fs.mkdir(extracted);
  await run(tar, ["-xf", archive, "-C", extracted, "--strip-components=1"]);
  await plainFile(path.join(extracted, host.os === "win32" ? "t3.exe" : "t3"));
  if (sameFilesystem) {
    await fs.writeFile(path.join(extracted, ".install-complete"), target + "\n", {
      flag: "wx",
      flush: true,
    });
    await fs.rename(extracted, dir);
  } else {
    // A cache on another volume cannot be renamed. Publish the sentinel only after the copy completes.
    await fs.mkdir(dir);
    try {
      await fs.cp(extracted, dir, { recursive: true, force: false, errorOnExist: true });
      await fs.writeFile(path.join(dir, ".install-complete"), target + "\n", {
        flag: "wx",
        flush: true,
      });
    } catch (error) {
      // An incomplete version dir would block the next rollback and prune; this one is ours.
      await fs.rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  await installed(host, target);
  return true;
}
async function maintain(request: Request) {
  requireState(
    request.confirmIdle === true,
    "Maintenance requires --confirm-idle; service was not stopped.",
  );
  const { host, expected } = request;
  requireState(expected !== undefined, "Missing preflight snapshot.");
  const target = version(request.version);
  const before = await inspect(host);
  running(before, host);
  unchanged(expected, before);
  await realDirectory(host.t3Home);
  await realDirectory(path.join(host.t3Home, "runtime"));
  await realDirectory(versionsPath(host));
  await realDirectory(path.join(host.t3Home, "userdata"));
  await mutableFile(host.service.file);
  await mutableFile(statePath(host));
  await installed(host, before.state.activeVersion);
  await installed(host, before.launcherVersion);
  const pruning = request.action === "prune";
  let downloaded = false;
  if (pruning) {
    requireState(target === before.state.activeVersion, "Prune target differs from activeVersion.");
    for (const v of before.versions) {
      version(v);
      await installed(host, v);
    }
    for (const name of before.backups) {
      await validateBackup(host, name, before);
    }
  } else {
    requireState(
      request.migrationsUnchanged === true,
      "Rollback migration compatibility is not confirmed; service was not stopped. Manual restore needs owner's go. After prune, fix forward.",
    );
    requireState(
      compareVersions(target, before.state.activeVersion) < 0,
      "Rollback target must be older than activeVersion.",
    );
    downloaded = await downloadUpstream(host, target);
  }
  await installed(host, target);
  const serviceContents = await rewrittenService(host, target, !pruning);
  requireState(
    !(await exists(path.join(host.t3Home, "runtime", ".service-state.host-maintenance"))),
    "An unfinished maintenance state file exists; resolve it before maintenance.",
  );
  unchanged(
    downloaded ? { ...before, versions: [...before.versions, target].sort() } : before,
    await inspect(host),
  );
  let stopped = false;
  try {
    await stop(host, before);
    stopped = true;
    await unchangedAfterStop(host, before);
    const keptBackup = await backup(host, before);
    await unchangedAfterStop(host, before);
    await fs.writeFile(host.service.file, serviceContents, { flush: true });
    if (!pruning) {
      // A terminal update record is tied to its old activeVersion; archive it in the backup, not in the new state.
      const next = { protocol: 3, activeVersion: target };
      const temporary = path.join(host.t3Home, "runtime", ".service-state.host-maintenance");
      await fs.writeFile(temporary, JSON.stringify(next) + "\n", {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      await fs.rename(temporary, statePath(host));
    }
    await start(host);
    stopped = false;
    const after = await verifyRestart(host, before, target);
    requireState(
      after.launcherVersion === target,
      "Launcher was not repointed; no retention was performed.",
    );
    if (pruning) {
      requireState(
        JSON.stringify(after.versions) === JSON.stringify(before.versions),
        "Version inventory changed during maintenance; no retention was performed.",
      );
      const expectedBackups = [...before.backups, path.basename(keptBackup)].sort();
      requireState(
        JSON.stringify(after.backups) === JSON.stringify(expectedBackups),
        "Backup inventory changed during maintenance; no retention was performed.",
      );
      await validateBackup(host, path.basename(keptBackup), before);
      for (const v of before.versions) {
        if (v === target) {
          continue;
        }
        const current = await inspect(host);
        running(current, host);
        requireState(
          current.state.activeVersion === target && current.launcherVersion === target,
          "Host version changed during retention; remaining directories were preserved.",
        );
        const dir = path.join(versionsPath(host), v);
        await installed(host, v);
        await fs.rm(dir, { recursive: true });
      }
      for (const name of before.backups) {
        await validateBackup(host, name, before);
        await fs.rm(path.join(backupRoot(host), name), { recursive: true });
      }
      const retained = await inspect(host);
      running(retained, host);
      requireState(
        retained.state.activeVersion === target &&
          retained.launcherVersion === target &&
          retained.versions.length === 1 &&
          retained.versions[0] === target &&
          retained.backups.length === 1 &&
          retained.backups[0] === path.basename(keptBackup),
        "Retention did not leave the active launcher, one installed version and one current cold backup; inspect before continuing.",
      );
    }
    if (downloaded) {
      const cache = path.join(host.cacheDir, target);
      await realDirectory(cache);
      await fs.rm(cache, { recursive: true });
    }
    return {
      action: request.action,
      activeVersion: target,
      restarted: true,
      databaseRestored: false,
      backup: path.basename(keptBackup),
      pruned: pruning,
      ...(pruning ? { migrationRollback: "After prune, fix forward if migrations changed." } : {}),
    };
  } catch (error) {
    throw new Refusal(
      `${error instanceof Error ? error.message : String(error)} Maintenance may be partial; service ${stopped ? "was stopped and was not automatically restarted" : "state must be inspected"}. No automatic repair was attempted.`,
      4,
    );
  }
}
async function build(request: Request) {
  const { host } = request;
  const v = version(request.version);
  requireState(
    typeof request.sha === "string" && /^[a-f0-9]{40}$/.test(request.sha),
    "Missing exact build SHA.",
  );
  const git = (...args: string[]) => run("git", args, { cwd: host.checkout });
  await realDirectory(host.checkout);
  requireState(
    (await git("branch", "--show-current")) === "main",
    "Build checkout is not on main.",
  );
  requireState((await git("status", "--porcelain")) === "", "Build checkout is dirty.");
  requireState(
    /^(?:https:\/\/github\.com\/|git@github\.com:)travisjneuman\/t3code(?:\.git)?$/.test(
      await git("remote", "get-url", "origin"),
    ),
    "Build checkout origin is not the fork.",
  );
  await git("fetch", "origin", "main");
  requireState(
    (await git("rev-parse", "origin/main")) === request.sha,
    "Build origin/main moved from the requested SHA.",
  );
  await git("merge-base", "--is-ancestor", "HEAD", request.sha);
  await git("merge", "--ff-only", request.sha);
  requireState(
    (await git("rev-parse", "HEAD")) === request.sha && (await git("status", "--porcelain")) === "",
    "Build checkout did not reach the exact clean SHA.",
  );
  const out = path.join(host.cacheDir, v);
  requireState(
    !(await exists(out)),
    "Build cache already exists; refusing to overwrite or silently reuse it.",
  );
  await cacheRoot(host);
  await fs.mkdir(out, { mode: 0o700 });
  await realDirectory(out);
  const log = path.join(out, "build.log");
  const args = [
    ...host.node.slice(1),
    "scripts/tjn-build-host-archive.ts",
    "--version",
    v,
    "--expect-sha",
    request.sha,
    "--out",
    out,
  ];
  try {
    const options = { cwd: host.checkout, log, env: { ...process.env, ...host.env } };
    if (host.os === "win32") {
      // The configured prefix may start with a .cmd shim (for example a managed Node runner).
      // Builds share the host with a live server; children inherit the lowered priority class.
      const script = `(Get-Process -Id $PID).PriorityClass = "BelowNormal"
& ${[host.node[0]!, ...args].map(psQuote).join(" ")}\nexit $LASTEXITCODE`;
      await run("powershell.exe", powershellArgs(script), options);
    } else {
      await run("nice", ["-n", "10", host.node[0]!, ...args], options);
    }
  } catch (error) {
    const file = await fs.open(log, "r");
    try {
      const { size } = await file.stat();
      const bytes = Buffer.alloc(Math.min(size, 16_384));
      await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      throw new Refusal(
        `${error instanceof Error ? error.message : String(error)}\nBuild log tail:\n${bytes.toString("utf8")}`,
        1,
      );
    } finally {
      await file.close();
    }
  }
  const file = await fs.open(log, "r");
  let tail: string;
  try {
    const { size } = await file.stat();
    const bytes = Buffer.alloc(Math.min(size, 16_384));
    await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    tail = bytes.toString("utf8");
  } finally {
    await file.close();
  }
  const result: unknown = JSON.parse(tail.trim().split(/\r?\n/).at(-1)!);
  requireState(
    record(result) &&
      typeof result.archive === "string" &&
      typeof result.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(result.sha256),
    "Builder did not emit its final archive/hash JSON.",
  );
  requireState(
    path.dirname(result.archive) === out,
    "Builder archive is outside the named version cache.",
  );
  await plainFile(result.archive);
  requireState(
    (await hashFile(result.archive)) === result.sha256,
    "Builder archive checksum disagrees with its receipt.",
  );
  requireState(
    (await git("status", "--porcelain")) === "" && (await git("rev-parse", "HEAD")) === request.sha,
    "Builder left a dirty or changed checkout.",
  );
  return result;
}
export async function runHost(request: Request) {
  requireState(
    process.platform === request.host.os && process.arch === "x64",
    "Configured host OS/architecture does not match the executing host.",
  );
  switch (request.action) {
    case "ready":
      return { ready: true };
    case "inspect":
      return inspect(request.host);
    case "build":
      return build(request);
    case "prune":
    case "rollback":
      return maintain(request);
    case "remove-cache": {
      const dir = path.join(request.host.cacheDir, version(request.version));
      await realDirectory(dir);
      await fs.rm(dir, { recursive: true });
      return { removedVersionCache: request.version };
    }
    default:
      throw new Refusal("Unknown host operation; no action was taken.");
  }
}
