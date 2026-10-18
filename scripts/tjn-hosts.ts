#!/usr/bin/env node
// Fork add-on: explicit Mac-owned orchestration for host-local builds and maintenance.
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  isUpdateTarget,
  powershellArgs,
  psQuote,
  record,
  Refusal,
  releaseVersion,
  requireState,
  run,
  shellQuote,
  version,
  type Host,
  type HostConfig,
  type Request,
  type Snapshot,
} from "./lib/tjn-hosts/remote.ts";
import { beginRun, heldLocks, runSummary, type Journal, type Step } from "./lib/tjn-hosts/runs.ts";

const REPOSITORY = "travisjneuman/t3code";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = path.join(homedir(), ".config", "t3code-fork", "hosts.json");
const FLEET_RESULT_FILE = path.join(
  homedir(),
  "Library",
  "Application Support",
  "t3code-fork",
  "host-fleet-build-result.json",
);
const USAGE = `Usage: node scripts/tjn-hosts.ts build-local --expect-sha <full-sha> [--result-file <path>]
       node scripts/tjn-hosts.ts status
       node scripts/tjn-hosts.ts prune <host>|--all --confirm-idle [--dry-run]
       node scripts/tjn-hosts.ts rollback <host> [--to version] --confirm-idle [--dry-run]
Exit codes: 0 success; 1 command/IO failure; 2 usage; 3 preflight refusal or locked host;
            4 fleet build may be partial (inspect host output before continuing).
For prune/rollback, --dry-run prints the read-only preflight and steps; it changes nothing and
does not need --confirm-idle. Changing runs lock each host they cover and keep a phase journal under
~/Library/Application Support/t3code-fork/host-runs.
Every configured host builds its own server from the exact pushed SHA and stages it locally.
No GitHub release, tag, archive transfer or service restart is part of this command. The existing
idle-aware Update flow activates the staged version later. Offline or failed hosts are listed and
must succeed on a later user-triggered Update. Rollback requiring a database restore is refused
before stopping the service. After pruning a migrated release, fix forward; this tool never writes
live userdata.`;

interface Release {
  tag_name: string;
  draft: boolean;
  body: string;
}

interface ReleaseReceipt {
  schemaVersion: 1;
  forkSha: string;
  upstreamTag: string;
  builders: Array<{ platform: Platform; role: string }>;
  migrations: Record<string, boolean>;
}

type Platform = "win32-x64" | "linux-x64";
const hostPath = (host: Host) => (host.os === "win32" ? path.win32 : path.posix);
const archiveName = (v: string, platform: Platform) =>
  `t3-${releaseVersion(v)}-${platform}.${platform === "win32-x64" ? "zip" : "tar.gz"}`;
const shown = (argv: string[]) =>
  argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : shellQuote(arg))).join(" ");
const remoteShown = (host: Host, request: Record<string, unknown>) =>
  `ssh ${host.ssh} <host payload> ${JSON.stringify(request)}`;

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

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\r\n\0]/.test(value);
}

async function config(): Promise<HostConfig> {
  const value: unknown = JSON.parse(await fs.readFile(CONFIG, "utf8"));
  requireState(
    record(value) && value.version === 1 && record(value.hosts),
    "Unsupported hosts.json shape; expected version 1 and hosts.",
  );
  const hosts = value.hosts;
  requireState(Object.keys(hosts).length > 0, "No hosts configured.");
  for (const [name, raw] of Object.entries(hosts)) {
    requireState(
      text(name) && !name.startsWith("-") && record(raw),
      "Invalid configured host entry.",
    );
    requireState(raw.os === "win32" || raw.os === "linux", "Unsupported configured host OS.");
    requireState(
      text(raw.ssh) && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(raw.ssh),
      "ssh must be a host alias, not shell syntax or options.",
    );
    requireState(
      Array.isArray(raw.node) && raw.node.length > 0 && raw.node.every(text),
      "node must be a nonempty argv prefix.",
    );
    requireState(
      record(raw.env) &&
        Object.entries(raw.env).every(
          ([key, val]) =>
            /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
            typeof val === "string" &&
            !/[\r\n\0]/.test(val),
        ),
      "Invalid host environment.",
    );
    requireState(typeof raw.loginShell === "boolean", "loginShell must be boolean.");
    requireState(record(raw.service) && text(raw.service.file), "Missing service file.");
    requireState(
      raw.os === "win32"
        ? raw.service.kind === "task" &&
            text(raw.service.name) &&
            !/[?*\[\]]/.test(raw.service.name)
        : raw.service.kind === "systemd" &&
            text(raw.service.unit) &&
            !raw.service.unit.startsWith("-"),
      "Service kind/name does not match host OS or contains selectors/options.",
    );
    const p = raw.os === "win32" ? path.win32 : path.posix;
    for (const entry of [raw.checkout, raw.t3Home, raw.cacheDir, raw.service.file]) {
      requireState(
        text(entry) && p.isAbsolute(entry),
        "Host paths must be absolute; no tilde or shell expansion.",
      );
    }
    const checkout = p.resolve(String(raw.checkout));
    const home = p.resolve(String(raw.t3Home));
    const cache = p.resolve(String(raw.cacheDir));
    const contains = (a: string, b: string) => {
      const left = raw.os === "win32" ? a.toLowerCase() : a;
      const right = raw.os === "win32" ? b.toLowerCase() : b;
      const relative = p.relative(left, right);
      return (
        relative === "" ||
        (!relative.startsWith(`..${p.sep}`) && relative !== ".." && !p.isAbsolute(relative))
      );
    };
    requireState(
      !contains(checkout, cache) &&
        !contains(cache, checkout) &&
        !contains(home, cache) &&
        !contains(cache, home),
      "Host cache must be disjoint from checkout and T3 home.",
    );
    requireState(
      !contains(p.join(home, "userdata"), raw.service.file),
      "Service file cannot be inside live userdata.",
    );
  }
  return value as unknown as HostConfig;
}

const git = (...args: string[]) => run("git", args, { cwd: ROOT });

// remoteSource() sends these to every host, so they must match the requested commit.
const SHIPPED_PATHS = [
  "scripts",
  "packages/shared/src/semver.ts",
  "apps/server/src/cloud/currentRuntime.ts",
];
const shippedFilesAt = async (sha: string) =>
  (await git("status", "--porcelain", "--", ...SHIPPED_PATHS)) === "" &&
  (await git("diff", "--name-only", sha, "--", ...SHIPPED_PATHS)) === "";
const gh = (...args: string[]) => run("gh", args, { cwd: ROOT });

async function releases(): Promise<Release[]> {
  const pages: unknown = JSON.parse(
    await gh("api", `repos/${REPOSITORY}/releases?per_page=100`, "--paginate", "--slurp"),
  );
  requireState(Array.isArray(pages) && pages.every(Array.isArray), "Invalid release listing.");
  const list: unknown[] = pages.flat();
  return list.map((item) => {
    requireState(
      record(item) &&
        text(item.tag_name) &&
        !item.tag_name.startsWith("-") &&
        typeof item.draft === "boolean" &&
        (item.body === null || typeof item.body === "string"),
      "Unexpected release metadata.",
    );
    return { tag_name: item.tag_name, draft: item.draft, body: item.body ?? "" };
  });
}

function currentRelease(list: Release[]) {
  const published = list.filter((release) => !release.draft);
  requireState(
    published.length === 1 && published[0]!.tag_name.startsWith("v"),
    "Expected exactly one published fork release.",
  );
  version(published[0]!.tag_name.slice(1));
  return published[0]!;
}

function remoteCommand(host: Host, request: Request) {
  const payload = Buffer.from(JSON.stringify(request)).toString("base64");
  const argv = [...host.node, "--input-type=module-typescript", "-", payload];
  let command: string;
  if (host.os === "win32") {
    const env = Object.entries(host.env)
      .map(([key, value]) => `$env:${key}=${psQuote(value)}`)
      .join("\n");
    const script = `${env}\n& ${argv.map(psQuote).join(" ")}\nexit $LASTEXITCODE`;
    command = ["powershell.exe", ...powershellArgs(script)].join(" ");
  } else {
    const env = Object.entries(host.env).map(([key, value]) => shellQuote(`${key}=${value}`));
    command = ["env", ...env, ...argv.map(shellQuote)].join(" ");
    if (host.loginShell) {
      command = `bash -lc ${shellQuote(command)}`;
    }
  }
  return [
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
    command,
  ];
}

async function remoteSource() {
  const source = await fs.readFile(new URL("./lib/tjn-hosts/remote.ts", import.meta.url), "utf8");
  const semver = await fs.readFile(
    new URL("../packages/shared/src/semver.ts", import.meta.url),
    "utf8",
  );
  const currentRuntime = await fs.readFile(
    new URL("../apps/server/src/cloud/currentRuntime.ts", import.meta.url),
    "utf8",
  );
  const sharedImport = 'import { compareSemverVersions } from "@t3tools/shared/semver";';
  const currentRuntimeImport = `import {
  currentRuntimePaths,
  syncCurrentRuntime,
} from "../../../apps/server/src/cloud/currentRuntime.ts";`;
  requireState(
    source.includes(sharedImport) && source.includes(currentRuntimeImport),
    "Remote payload shared imports changed; refusing an incomplete payload.",
  );
  // Ship the exact shared implementations: remote preflight must also work before dependencies are
  // installed, and runtime/current must be laid out exactly as the service launcher lays it out.
  return `${semver}\n${currentRuntime}\n${source.replace(sharedImport, "").replace(currentRuntimeImport, "")}\ntry {
  const request = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
  const result = await runHost(request);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof Refusal ? error.exitCode : 1;
}\n`;
}

async function remote(host: Host, request: Omit<Request, "host">): Promise<unknown> {
  const output = await run("ssh", remoteCommand(host, { ...request, host }), {
    input: await remoteSource(),
  });
  return JSON.parse(output);
}

async function snapshot(host: Host): Promise<Snapshot> {
  const value = await remote(host, { action: "inspect" });
  requireState(
    record(value) &&
      record(value.state) &&
      (value.runtime === null || record(value.runtime)) &&
      Array.isArray(value.versions) &&
      Array.isArray(value.backups) &&
      record(value.backupVersions) &&
      record(value.backupErrors) &&
      Array.isArray(value.stagingBackups),
    "Invalid host snapshot.",
  );
  version(value.state.activeVersion);
  return value as unknown as Snapshot;
}

interface LocalBuildPlan {
  sha: string;
  nightly: string;
  targetVersion: string;
}

async function localBuildPreflight(sha: string): Promise<LocalBuildPlan> {
  requireState(/^[a-f0-9]{40}$/.test(sha), "Expected a full lowercase commit SHA.");
  requireState((await git("branch", "--show-current")) === "main", "Mac checkout is not on main.");
  requireState(await shippedFilesAt(sha), "The host build tools differ from the requested commit.");
  for (const args of [
    ["remote", "get-url", "origin"],
    ["remote", "get-url", "--push", "origin"],
  ]) {
    requireState(
      /^(?:https:\/\/github\.com\/|git@github\.com:)travisjneuman\/t3code(?:\.git)?$/.test(
        await git(...args),
      ),
      "Origin must fetch and push only the fork.",
    );
  }
  requireState(
    /^(?:https:\/\/github\.com\/|git@github\.com:)pingdotgg\/t3code(?:\.git)?$/.test(
      await git("remote", "get-url", "upstream"),
    ),
    "Upstream remote is not the expected repository.",
  );
  requireState((await git("cat-file", "-t", sha)) === "commit", "Requested SHA is not a local commit.");
  requireState(
    (await git("ls-remote", "origin", "refs/heads/main")).split(/\s/)[0] === sha,
    "The requested SHA is not the current pushed origin/main commit.",
  );

  const tags = (await git("tag", "--merged", sha, "--list", "v*-nightly.*"))
    .split("\n")
    .filter(Boolean);
  const nightly = tags
    .map((tag) => version(tag.slice(1)))
    .sort(compareVersions)
    .at(-1);
  requireState(nightly !== undefined, "No merged upstream nightly tag found for the requested commit.");
  const tag = `v${nightly}`;
  requireState(
    (await git("cat-file", "-t", `refs/tags/${tag}`)) === "commit",
    "Upstream nightly tag is not lightweight; refusing to build from it.",
  );
  const tagSha = await git("rev-parse", `refs/tags/${tag}`);
  requireState(
    (await git("ls-remote", "upstream", `refs/tags/${tag}`)).split(/\s/)[0] === tagSha,
    "Local nightly tag differs from upstream.",
  );
  return { sha, nightly, targetVersion: version(`${nightly}+${sha.slice(0, 12)}`) };
}

function resultFile(value: string | undefined) {
  const selected = path.resolve(value ?? FLEET_RESULT_FILE);
  requireState(
    path.isAbsolute(selected) && selected === FLEET_RESULT_FILE,
    `--result-file must be ${FLEET_RESULT_FILE}.`,
  );
  return selected;
}

async function clearResultFile(file: string) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  requireState(
    (await fs.realpath(directory)) === directory,
    "Fleet result directory resolves through a link; refusing to write it.",
  );
  try {
    const stat = await fs.lstat(file);
    requireState(stat.isFile() && !stat.isSymbolicLink(), "Fleet result path is not a regular file.");
    await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function writeResultFile(file: string, commit: string, targetVersion: string) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ commit, targetVersion })}\n`, {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function buildLocal(
  cfg: HostConfig,
  sha: string,
  resultPath: string,
) {
  const hosts = Object.keys(cfg.hosts);
  const failures: string[] = [];
  const completed: string[] = [];
  await changing("build-local", hosts, "whole", async (journal) => {
    journal.plan([
      {
        host: null,
        phase: "clear-result",
        mutates: true,
        does: [`remove stale result ${resultPath}`],
        ifStopped: "The stale result was removed; no host build may have started.",
      },
      ...hosts.map((name): Step => ({
        host: name,
        phase: "build-and-stage",
        mutates: true,
        does: [
          remoteShown(cfg.hosts[name]!, {
            action: "build-and-stage",
            version: "<nightly>+<requested-sha-12>",
            sha,
          }),
          "build from the exact requested commit on this host, install it as a local pending runtime, and remove the intermediate archive",
        ],
        ifStopped: `${name} may have a partial build cache or a fully staged runtime; inspect that host before retrying.`,
      })),
      {
        host: null,
        phase: "write-result",
        mutates: true,
        does: [`write ${resultPath} only after every configured host staged this target`],
        ifStopped: "All hosts may be staged, but the desktop will not queue activation without the result file.",
      },
    ]);
    await journal.step(null, "clear-result", () => clearResultFile(resultPath));
    const plan = await journal.step(null, "preflight", () => localBuildPreflight(sha));

    for (const name of hosts) {
      const host = cfg.hosts[name]!;
      try {
        console.log(`${name}: building and staging ${plan.targetVersion} from ${sha}.`);
        const value = await journal.step(name, "build-and-stage", () =>
          remote(host, {
            action: "build-and-stage",
            version: plan.targetVersion,
            sha: plan.sha,
          }),
        );
        requireState(
          record(value) &&
            value.targetVersion === plan.targetVersion &&
            ["staged", "already-staged", "already-active"].includes(String(value.status)),
          `${name}: host returned an unexpected build result.`,
        );
        console.log(`${name}: ${String(value.status)} ${plan.targetVersion}.`);
        completed.push(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${name}: ${message}`);
        console.error(`${name}: build/stage failed or host is offline: ${message}`);
      }
    }
    if (failures.length > 0) {
      throw new Refusal(
        `Fleet build incomplete for ${plan.targetVersion}. Completed: ${completed.join(", ") || "none"}. Pending or failed: ${failures.join(" | ")}. No success result was written; use the desktop Retry action to repeat this same commit.`,
        4,
      );
    }
    await journal.step(null, "write-result", () =>
      writeResultFile(resultPath, plan.sha, plan.targetVersion),
    );
    console.log(JSON.stringify({ commit: plan.sha, targetVersion: plan.targetVersion }));
  });
}

function releaseReceipt(release: Release): ReleaseReceipt {
  const markers = [...release.body.matchAll(/<!-- t3-host-release (.+) -->/g)];
  requireState(markers.length === 1, `Release ${release.tag_name} has no unique receipt.`);
  let receipt: unknown;
  try {
    receipt = JSON.parse(markers[0]![1]!);
  } catch {
    throw new Refusal(`Release ${release.tag_name} has a malformed receipt.`);
  }
  requireState(
    record(receipt) &&
      receipt.schemaVersion === 1 &&
      receipt.upstreamTag === release.tag_name &&
      typeof receipt.forkSha === "string" &&
      /^[a-f0-9]{40}$/.test(receipt.forkSha) &&
      record(receipt.migrations) &&
      Object.values(receipt.migrations).every((changed) => typeof changed === "boolean"),
    `Release ${release.tag_name} has an invalid receipt.`,
  );
  return receipt as unknown as ReleaseReceipt;
}

/** The runtime id hosts install from this release: its nightly plus its fork build. */
const releaseId = (release: Release) =>
  version(`${release.tag_name.slice(1)}+${releaseReceipt(release).forkSha.slice(0, 12)}`);

function refuseRestore(host: Host, before: Snapshot, target: string): never {
  const p = host.os === "win32" ? path.win32 : path.posix;
  const compatible = before.backups.filter((name) => before.backupVersions[name] === target);
  const available = compatible.length > 0 ? compatible : before.backups;
  const backupMessage =
    available.length > 0
      ? `Exact retained backup paths: ${available.map((name) => p.join(host.t3Home, "backups", name)).join(", ")}. ${compatible.length === 0 ? "None is recorded for the rollback target. " : ""}`
      : "No cold backup exists; a compatible recovery point must be identified manually. ";
  throw new Refusal(
    `Rollback requires a DB restore or has unknown migration compatibility. Service was not stopped. Manual restore needs owner's go; this tool never writes userdata. ${backupMessage}After prune, fix forward rather than restoring a post-migration backup into older code.`,
  );
}

type MaintenanceCommand = "prune" | "rollback";
interface Maintenance {
  name: string;
  host: Host;
  before: Snapshot;
  target: string;
}

// Read-only host inspection. Rollback additionally needs a verified legacy release receipt.
async function maintenancePreflight(
  command: MaintenanceCommand,
  cfg: HostConfig,
  selected: string[],
  target: string | undefined,
): Promise<Maintenance[]> {
  const releaseInfo = command === "rollback" ? currentRelease(await releases()) : undefined;
  const current = releaseInfo === undefined ? undefined : releaseId(releaseInfo);
  const work: Maintenance[] = [];
  for (const name of selected) {
    const host = cfg.hosts[name]!;
    const before = await snapshot(host);
    if (command === "prune") {
      work.push({ name, host, before, target: before.state.activeVersion });
      continue;
    }
    requireState(
      before.state.activeVersion === current,
      "Host is not on the published fork release.",
    );
    let to = current;
    if (command === "rollback") {
      const previous =
        target ??
        (before.state.update?.status === "committed" ? before.state.update.fromVersion : undefined);
      requireState(
        previous !== undefined,
        "No previous committed version is recorded; specify --to explicitly or fix forward.",
      );
      to = version(previous);
      requireState(
        isUpdateTarget(current, to),
        "Rollback target must be older than the active release.",
      );
      // Only upstream's plain nightlies can be downloaded again.
      requireState(
        releaseVersion(to) === to || before.versions.includes(to),
        "That fork build is no longer installed; fix forward.",
      );
      let receipt: ReleaseReceipt;
      try {
        receipt = releaseReceipt(releaseInfo!);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        refuseRestore(host, before, to);
      }
      if (receipt.migrations[to] !== false) {
        refuseRestore(host, before, to);
      }
      if (!target) {
        requireState(
          before.versions.includes(to),
          "Previous version is no longer installed; specify --to explicitly or fix forward.",
        );
      }
    }
    work.push({ name, host, before, target: to });
  }
  return work;
}

// Mirrors remote.ts maintain(); the host still rechecks everything before it stops anything.
function maintenanceSteps(
  command: MaintenanceCommand,
  work: Maintenance[],
  explicitTarget: boolean,
): Step[] {
  return work.map(({ name, host, before, target }): Step => {
    const hp = hostPath(host);
    const runtime = hp.join(host.t3Home, "runtime");
    const service = host.service;
    const download = command === "rollback" && !before.versions.includes(target);
    const listed = (items: string[]) => (items.length > 0 ? items.join(", ") : "(none)");
    return {
      host: name,
      phase: command,
      mutates: true,
      does: [
        remoteShown(host, {
          action: command,
          version: target,
          expected: "<preflight snapshot>",
          migrationsUnchanged: command === "rollback",
          confirmIdle: true,
        }),
        "on host: recheck the snapshot, backups and free space while the service still runs",
        ...(download
          ? [
              `on host: download and verify https://github.com/pingdotgg/t3code/releases/download/v${target}/${archiveName(target, `${host.os}-x64`)} into ${hp.join(host.cacheDir, target)}, then install ${hp.join(runtime, "versions", target)}`,
            ]
          : []),
        service.kind === "systemd"
          ? `on host: systemctl --user stop ${service.unit}`
          : `on host: taskkill /PID <task conhost above server pid ${before.runtime?.pid ?? "?"}> /T /F; schtasks /end /tn ${JSON.stringify(service.name)}`,
        `on host: cold backup of ${before.state.activeVersion} into ${hp.join(host.t3Home, "backups", `cold-${before.state.activeVersion}-<timestamp>`)}`,
        `on host: fill ${hp.join(runtime, "current")} with ${target} and point ${service.file} at its launcher${
          command === "rollback"
            ? `${before.releaseBaseUrlSet ? ", dropping the fork T3CODE_RELEASE_BASE_URL line" : ""}; set activeVersion ${target} in ${hp.join(runtime, "service-state.json")}`
            : ""
        }`,
        service.kind === "systemd"
          ? `on host: systemctl --user daemon-reload; systemctl --user start ${service.unit}`
          : `on host: schtasks /run /tn ${JSON.stringify(service.name)}`,
        `on host: confirm ${target} is running within 60 seconds`,
        ...(command === "prune"
          ? [
              `on host: delete from ${hp.join(runtime, "versions")}: ${listed(before.versions.filter((v) => v !== target))}`,
              `on host: delete from ${hp.join(host.t3Home, "backups")}: ${listed(before.backups)}`,
            ]
          : []),
        ...(download ? [`on host: rm -r ${hp.join(host.cacheDir, target)}`] : []),
      ],
      ifStopped: `If the error says the service was not stopped, ${name} kept running unchanged; otherwise maintenance may be partial and the service may still be stopped. Read \`status\` before choosing recovery.`,
      rerun: `node scripts/tjn-hosts.ts ${command} ${name}${explicitTarget ? ` --to ${target}` : ""} --confirm-idle`,
    };
  });
}

async function maintain(command: MaintenanceCommand, work: Maintenance[], journal: Journal) {
  let completed = 0;
  for (const item of work) {
    try {
      const result = await journal.step(item.name, command, () =>
        remote(item.host, {
          action: command,
          version: item.target,
          expected: item.before,
          migrationsUnchanged: command === "rollback",
          confirmIdle: true,
        }),
      );
      console.log(JSON.stringify({ host: item.name, result }));
      completed += 1;
    } catch (error) {
      if (completed > 0 || (error instanceof Refusal && error.exitCode === 255)) {
        throw new Refusal(
          `Maintenance may be partial; ${completed} selected hosts completed before this failure. Inspect status before continuing. ${error instanceof Error ? error.message : String(error)}`,
          4,
        );
      }
      throw error;
    }
  }
}

const PREFLIGHT: Step = {
  host: null,
  phase: "preflight",
  mutates: false,
  does: ["read-only checks of the checkout, fork releases and host snapshots"],
  ifStopped: "Read-only; nothing was changed.",
};

async function changing(
  command: string,
  hosts: string[],
  rerun: "per-host" | "whole",
  body: (journal: Journal) => Promise<void>,
) {
  const run = await beginRun(command, hosts, rerun);
  try {
    run.journal.plan([PREFLIGHT]);
    await body(run.journal);
    run.journal.succeed();
  } catch (error) {
    run.journal.fail(error);
    if (!run.journal.touched()) {
      throw error;
    }
    throw new Refusal(
      `${error instanceof Error ? error.message : String(error)}\n${run.journal.report()}`,
      error instanceof Refusal ? error.exitCode : 1,
    );
  } finally {
    run.release();
  }
}

async function printDryRun(heading: string[], hosts: string[], steps: Step[]) {
  console.log(
    [
      ...heading,
      "Dry run: preflight passed; nothing was changed and no lock or journal was written.",
      `A real run locks: ${hosts.join(", ")}.`,
    ].join("\n"),
  );
  for (const lock of await heldLocks(hosts)) {
    console.log(
      `Currently locked: ${lock.host} by \`${lock.command}\` (pid ${lock.pid} on ${lock.machine}, started ${lock.startedAt}${lock.holderRunning === false ? "; holder has exited" : ""}).`,
    );
  }
  for (const step of steps) {
    console.log(`[${step.host ?? "Mac"}] ${step.phase}`);
    for (const line of step.does) {
      console.log(`  ${line}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(USAGE);
    return;
  }
  const command = args.shift();
  if (command === "release") {
    throw new Refusal(
      "The legacy release command is retired and will not build or publish hosts. Update the desktop app, then Retry the failed host build.",
      2,
    );
  }
  let hostName: string | undefined;
  let expectSha: string | undefined;
  let requestedResultFile: string | undefined;
  let target: string | undefined;
  let all = false;
  let idle = false;
  let dryRun = false;
  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--all" && command === "prune" && !all) {
      all = true;
    } else if (
      arg === "--confirm-idle" &&
      (command === "prune" || command === "rollback") &&
      !idle
    ) {
      idle = true;
    } else if (
      arg === "--dry-run" &&
      (command === "prune" || command === "rollback") &&
      !dryRun
    ) {
      dryRun = true;
    } else if (
      arg === "--expect-sha" &&
      command === "build-local" &&
      !expectSha
    ) {
      expectSha = args.shift();
      if (!expectSha || !/^[a-f0-9]{40}$/.test(expectSha)) {
        throw new Refusal("--expect-sha needs a full commit SHA.\n" + USAGE, 2);
      }
    } else if (
      arg === "--result-file" &&
      command === "build-local" &&
      !requestedResultFile
    ) {
      requestedResultFile = args.shift();
      if (!requestedResultFile || requestedResultFile.startsWith("-")) {
        throw new Refusal("--result-file needs an absolute path.\n" + USAGE, 2);
      }
    } else if (arg === "--to" && command === "rollback" && !target) {
      target = args.shift();
      if (!target || target.startsWith("-")) {
        throw new Refusal("--to needs an exact version.\n" + USAGE, 2);
      }
    } else if (
      !arg.startsWith("-") &&
      (command === "prune" || command === "rollback") &&
      !hostName
    ) {
      hostName = arg;
    } else {
      throw new Refusal(USAGE, 2);
    }
  }
  if (
    !command ||
    !["build-local", "status", "prune", "rollback"].includes(command) ||
    ((command === "prune" || command === "rollback") && all === Boolean(hostName)) ||
    (command === "build-local" && !expectSha)
  ) {
    throw new Refusal(USAGE, 2);
  }
  requireState(
    process.platform === "darwin",
    "This CLI runs on the Mac; build hosts are reached over SSH.",
  );
  if ((command === "prune" || command === "rollback") && !dryRun) {
    requireState(
      idle,
      "Restart interrupts agent turns and terminals. Confirm all selected hosts are idle with --confirm-idle. No host was changed.",
    );
  }
  const cfg = await config();
  if (command === "build-local") {
    const selectedResultFile = resultFile(requestedResultFile);
    await buildLocal(cfg, expectSha!, selectedResultFile);
    return;
  }
  if (command === "status") {
    // Host state stays readable when the GitHub listing is down.
    let failed = false;
    try {
      const published = await releases();
      console.log(
        JSON.stringify({
          forkReleases: published.map((item) => ({ tag: item.tag_name, draft: item.draft })),
        }),
      );
    } catch (error) {
      failed = true;
      console.error(`fork releases: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      console.log(JSON.stringify({ hostRuns: await runSummary() }));
    } catch (error) {
      failed = true;
      console.error(`host runs: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const [name, host] of Object.entries(cfg.hosts)) {
      try {
        console.log(JSON.stringify({ host: name, ...(await snapshot(host)) }));
      } catch (error) {
        failed = true;
        console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failed) {
      throw new Refusal(
        "The fork releases, host-run state or one or more host statuses could not be read.",
        1,
      );
    }
    return;
  }
  const maintenance: MaintenanceCommand = command === "prune" ? "prune" : "rollback";
  const selected = all ? Object.keys(cfg.hosts) : [hostName!];
  requireState(
    selected.every((name) => Object.hasOwn(cfg.hosts, name)),
    "Unknown configured host.",
  );
  if (dryRun) {
    const work = await maintenancePreflight(maintenance, cfg, selected, target);
    await printDryRun(
      [
        `${maintenance} ${selected.join(", ")}${idle ? "" : " (a real run also needs --confirm-idle)"}`,
        ...work.map((item) => `${item.name}: ${item.before.state.activeVersion} -> ${item.target}`),
      ],
      selected,
      maintenanceSteps(maintenance, work, target !== undefined),
    );
    return;
  }
  await changing(maintenance, selected, "per-host", async (journal) => {
    const work = await journal.step(null, "preflight", () =>
      maintenancePreflight(maintenance, cfg, selected, target),
    );
    journal.plan(maintenanceSteps(maintenance, work, target !== undefined));
    await maintain(maintenance, work, journal);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof Refusal && error.exitCode !== 255 ? error.exitCode : 1;
});
