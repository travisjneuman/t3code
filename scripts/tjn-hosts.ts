#!/usr/bin/env node
// Fork add-on: deliberate Mac-owned host releases, without hosted build automation.
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  hashFile,
  powershellArgs,
  psQuote,
  record,
  Refusal,
  requireState,
  run,
  shellQuote,
  version,
  type Host,
  type HostConfig,
  type Request,
  type Snapshot,
} from "./lib/tjn-hosts/remote.ts";

const REPOSITORY = "travisjneuman/t3code";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = path.join(homedir(), ".config", "t3code-fork", "hosts.json");
const CACHE = path.join(homedir(), "Library", "Caches", "t3code-fork-release");
const PLATFORMS = ["win32-x64", "linux-x64"] as const;
const USAGE = `Usage: node scripts/tjn-hosts.ts release [--build-host name]
       node scripts/tjn-hosts.ts status
       node scripts/tjn-hosts.ts prune <host>|--all --confirm-idle
       node scripts/tjn-hosts.ts rollback <host> [--to version] --confirm-idle
Exit codes: 0 success; 1 command/IO failure; 2 usage; 3 preflight refusal;
            4 maintenance/publication may be partial (inspect before continuing).
Unreachable hosts are reported and skipped during release preflight only.
Rollback requiring a database restore is refused before stopping the service.
After pruning a migrated release, fix forward; this tool never writes live userdata.`;

interface Release {
  tag_name: string;
  draft: boolean;
  body: string;
}

interface ReleaseReceipt {
  schemaVersion: 1;
  forkSha: string;
  upstreamTag: string;
  builders: Array<{ platform: (typeof PLATFORMS)[number]; role: string }>;
  migrations: Record<string, boolean>;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\r\n\0]/.test(value);
}

async function config(): Promise<HostConfig> {
  const value: unknown = JSON.parse(await fs.readFile(CONFIG, "utf8"));
  requireState(
    record(value) && value.version === 1 && record(value.hosts) && record(value.buildHosts),
    "Unsupported hosts.json shape; expected version 1, hosts, and buildHosts.",
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
  for (const platform of PLATFORMS) {
    const names = value.buildHosts[platform];
    requireState(
      Array.isArray(names) &&
        names.length > 0 &&
        new Set(names).size === names.length &&
        names.every(
          (name) =>
            typeof name === "string" &&
            Object.hasOwn(hosts, name) &&
            record(hosts[name]) &&
            `${hosts[name].os}-x64` === platform,
        ),
      "Each buildHosts platform must list distinct matching configured hosts.",
    );
  }
  return value as unknown as HostConfig;
}

const git = (...args: string[]) => run("git", args, { cwd: ROOT });
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
  return ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host.ssh, command];
}

async function remoteSource() {
  const source = await fs.readFile(new URL("./lib/tjn-hosts/remote.ts", import.meta.url), "utf8");
  const semver = await fs.readFile(
    new URL("../packages/shared/src/semver.ts", import.meta.url),
    "utf8",
  );
  const sharedImport = 'import { compareSemverVersions } from "@t3tools/shared/semver";';
  requireState(
    source.includes(sharedImport),
    "Remote payload shared-semver import changed; refusing an incomplete payload.",
  );
  // Ship the exact shared implementation: remote preflight must also work before dependencies are installed.
  return `${semver}\n${source.replace(sharedImport, "")}\ntry {
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
      record(value.backupVersions),
    "Invalid host snapshot.",
  );
  version(value.state.activeVersion);
  return value as unknown as Snapshot;
}

async function copyArchive(host: Host, v: string, destination: string) {
  const p = host.os === "win32" ? path.win32 : path.posix;
  const joined = p
    .join(host.cacheDir, v, `t3-${v}-${host.os}-x64.${host.os === "win32" ? "zip" : "tar.gz"}`)
    .replaceAll("\\", "/");
  // Windows OpenSSH's SFTP resolves `C:/...` against the home directory; absolute drive paths need `/C:/...`.
  const source = host.os === "win32" ? `/${joined}` : joined;
  const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  // SFTP preserves archive bytes; native stdout piped through Windows PowerShell does not.
  await run("sftp", ["-b", "-", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host.ssh], {
    input: `get ${quote(source)} ${quote(destination)}\n`,
  });
}

async function release(cfg: HostConfig, override?: string) {
  if (override) {
    requireState(
      PLATFORMS.some((platform) => cfg.buildHosts[platform].includes(override)),
      "--build-host must name a configured platform build host.",
    );
  }
  requireState((await git("branch", "--show-current")) === "main", "Mac checkout is not on main.");
  requireState((await git("status", "--porcelain")) === "", "Mac checkout is dirty.");
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
  const sha = await git("rev-parse", "HEAD");
  requireState(
    sha === (await git("rev-parse", "origin/main")),
    "Mac HEAD differs from origin/main.",
  );
  requireState(
    (await git("ls-remote", "origin", "refs/heads/main")).split(/\s/)[0] === sha,
    "Origin/main moved; synchronize before releasing.",
  );
  const tags = (await git("tag", "--merged", "HEAD", "--list", "v*-nightly.*"))
    .split("\n")
    .filter(Boolean);
  const v = tags
    .map((tag) => version(tag.slice(1)))
    .sort(compareVersions)
    .at(-1);
  requireState(v !== undefined, "No merged upstream nightly tag found.");
  const tag = `v${v}`;
  requireState(
    (await git("cat-file", "-t", `refs/tags/${tag}`)) === "commit",
    "Upstream tag is not lightweight; refusing to create or rewrite tags.",
  );
  const tagSha = await git("rev-parse", `refs/tags/${tag}`);
  requireState(
    (await git("ls-remote", "upstream", `refs/tags/${tag}`)).split(/\s/)[0] === tagSha,
    "Local nightly tag differs from upstream.",
  );
  const originTag = await git("ls-remote", "origin", `refs/tags/${tag}`);
  requireState(
    !originTag || originTag.split(/\s/)[0] === tagSha,
    "Origin tag differs from upstream; refusing to rewrite it.",
  );
  const runtime: unknown = JSON.parse(
    await fs.readFile(path.join(homedir(), ".t3", "userdata", "server-runtime.json"), "utf8"),
  );
  requireState(record(runtime) && runtime.serverVersion === v, "run the Mac's fork update first");
  const existing = await releases();
  requireState(
    !existing.some((item) => item.tag_name === tag),
    "Fork release already exists; same-version publication is refused.",
  );

  const snapshots = new Map<string, Snapshot>();
  const skipped: string[] = [];
  for (const [name, host] of Object.entries(cfg.hosts)) {
    let state: Snapshot;
    try {
      state = await snapshot(host);
    } catch (error) {
      if (!(error instanceof Refusal) || error.exitCode !== 255) {
        throw error;
      }
      skipped.push(name);
      console.error(`${name}: unreachable; skipped release preflight and builder selection.`);
      continue;
    }
    requireState(
      compareVersions(state.state.activeVersion, v) < 0,
      "no newer nightly than the hosts yet; wait for one",
    );
    snapshots.set(name, state);
  }
  const chosen = PLATFORMS.map((platform) => {
    const choices = cfg.buildHosts[platform];
    const candidates = override && choices.includes(override) ? [override] : choices;
    const name = candidates.find((candidate) => snapshots.has(candidate));
    requireState(
      name !== undefined,
      `No reachable configured build host for ${platform}${override && choices.includes(override) ? " (explicit selection)" : ""}.`,
    );
    return { platform, name, host: cfg.hosts[name]!, ordinal: choices.indexOf(name) + 1 };
  });

  const migrations: Record<string, boolean> = {};
  for (const state of snapshots.values()) {
    const from = state.state.activeVersion;
    if (Object.hasOwn(migrations, from)) {
      continue;
    }
    // Only upstream migrations determine this receipt: the additive fork ledger is independent.
    const baseline = await git("rev-parse", `refs/tags/v${from}^{commit}`);
    requireState(
      (await git("ls-remote", "upstream", `refs/tags/v${from}`)).split(/\s/)[0] === baseline,
      "Migration baseline tag differs from upstream or is unavailable.",
    );
    const changed = await git(
      "diff",
      "--name-only",
      `refs/tags/v${from}`,
      sha,
      "--",
      "apps/server/src/persistence/Migrations.ts",
      "apps/server/src/persistence/Migrations",
      "apps/server/src/persistence/reconcileV2PreviewMigration.ts",
    );
    migrations[from] = changed !== "";
  }

  const staging = path.join(CACHE, v);
  requireState(
    path.resolve(await fs.realpath(path.dirname(CACHE))) === path.resolve(path.dirname(CACHE)),
    "Mac cache parent traverses a link.",
  );
  await fs.mkdir(CACHE, { recursive: true, mode: 0o700 });
  requireState(
    path.resolve(await fs.realpath(CACHE)) === path.resolve(CACHE),
    "Mac release cache traverses a link.",
  );
  await fs.mkdir(staging, { mode: 0o700 });
  const results = await Promise.allSettled(
    chosen.map(async (build) => {
      const result = await remote(build.host, { action: "build", version: v, sha });
      requireState(
        record(result) &&
          typeof result.archive === "string" &&
          typeof result.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(result.sha256),
        "Invalid host builder receipt.",
      );
      const name = `t3-${v}-${build.platform}.${build.platform === "win32-x64" ? "zip" : "tar.gz"}`;
      const p = build.host.os === "win32" ? path.win32 : path.posix;
      requireState(
        result.archive === p.join(build.host.cacheDir, v, name),
        "Builder returned an unexpected archive path.",
      );
      const destination = path.join(staging, name);
      await copyArchive(build.host, v, destination);
      requireState(
        (await hashFile(destination)) === result.sha256,
        "Transferred archive differs from the host checksum.",
      );
      return { ...build, destination, name, sha256: result.sha256 };
    }),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new Refusal(
      `${failures.map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason))).join("\n")}\nBuild failed; named version caches are retained for inspection. No release was published.`,
      1,
    );
  }
  const built = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const sums = path.join(staging, "SHA256SUMS");
  await fs.writeFile(sums, built.map((build) => `${build.sha256}  ${build.name}\n`).join(""), {
    flag: "wx",
  });
  const receipt: ReleaseReceipt = {
    schemaVersion: 1,
    forkSha: sha,
    upstreamTag: tag,
    builders: built.map((build) => ({
      platform: build.platform,
      role: build.ordinal === 1 ? "primary" : `fallback-${build.ordinal - 1}`,
    })),
    migrations,
  };
  const notes = [
    `Fork SHA: ${sha}`,
    `Upstream nightly: ${tag} (${tagSha})`,
    ...receipt.builders.map((builder) => `${builder.platform}: ${builder.role} builder`),
    ...Object.entries(migrations).map(
      ([from, changed]) =>
        `Upstream migrations since ${from}: ${changed ? "changed; automated rollback refused, manual restore needs owner's go" : "unchanged"}.`,
    ),
    "After pruning a migrated release, fix forward. This tool never restores live userdata.",
    `<!-- t3-host-release ${JSON.stringify(receipt)} -->`,
  ].join("\n\n");
  const notesFile = path.join(staging, "release-notes.md");
  await fs.writeFile(notesFile, notes, { flag: "wx" });
  requireState(
    (await git("status", "--porcelain")) === "" && (await git("rev-parse", "HEAD")) === sha,
    "Mac checkout changed during the build; publication refused.",
  );
  requireState(
    (await git("rev-parse", `refs/tags/${tag}`)) === tagSha,
    "Upstream tag changed during the build; publication refused.",
  );
  try {
    await git("push", "origin", `refs/tags/${tag}`);
    await gh(
      "release",
      "create",
      tag,
      "--repo",
      REPOSITORY,
      "--prerelease",
      "--verify-tag",
      "--title",
      `T3 Code host release ${v}`,
      "--notes-file",
      notesFile,
      ...built.map((build) => build.destination),
      sums,
    );
    const afterPublish = await releases();
    requireState(
      afterPublish.length === existing.length + 1 &&
        afterPublish.some((item) => item.tag_name === tag && !item.draft) &&
        afterPublish.every(
          (item) =>
            item.tag_name === tag ||
            existing.some((old) => old.tag_name === item.tag_name && old.draft === item.draft),
        ),
      "Release inventory changed concurrently; retention was not performed.",
    );
    for (const old of existing) {
      await gh("release", "delete", old.tag_name, "--repo", REPOSITORY, "--yes");
    }
    for (const build of built) {
      await remote(build.host, { action: "remove-cache", version: v });
    }
    await fs.rm(staging, { recursive: true });
  } catch (error) {
    throw new Refusal(
      `Publication/retention may be partial; inspect the fork release and named version caches before continuing. No retry or repair was attempted. ${error instanceof Error ? error.message : String(error)}`,
      4,
    );
  }
  console.log(`Published ${tag}; retained tags, removed other releases and build caches.`);
  if (skipped.length > 0) {
    console.log(`Unreachable hosts skipped (not validated or changed): ${skipped.join(", ")}`);
  }
  console.log("Mac app → Update everything");
}

function migrationReceipt(release: Release): ReleaseReceipt {
  const markers = [...release.body.matchAll(/<!-- t3-host-release (.+) -->/g)];
  requireState(
    markers.length === 1,
    "Release has no unique migration receipt; service was not stopped.",
  );
  let receipt: unknown;
  try {
    receipt = JSON.parse(markers[0]![1]!);
  } catch {
    throw new Refusal("Release migration receipt is malformed; service was not stopped.");
  }
  requireState(
    record(receipt) &&
      receipt.schemaVersion === 1 &&
      receipt.upstreamTag === release.tag_name &&
      typeof receipt.forkSha === "string" &&
      /^[a-f0-9]{40}$/.test(receipt.forkSha) &&
      record(receipt.migrations) &&
      Object.values(receipt.migrations).every((changed) => typeof changed === "boolean"),
    "Release migration receipt is invalid; service was not stopped.",
  );
  return receipt as unknown as ReleaseReceipt;
}

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

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(USAGE);
    return;
  }
  const command = args.shift();
  let hostName: string | undefined;
  let buildHost: string | undefined;
  let target: string | undefined;
  let all = false;
  let idle = false;
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
    } else if (arg === "--build-host" && command === "release" && !buildHost) {
      buildHost = args.shift();
      if (!buildHost || buildHost.startsWith("-")) {
        throw new Refusal("--build-host needs a configured name.\n" + USAGE, 2);
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
    !["release", "status", "prune", "rollback"].includes(command) ||
    ((command === "prune" || command === "rollback") && all === Boolean(hostName))
  ) {
    throw new Refusal(USAGE, 2);
  }
  requireState(
    process.platform === "darwin",
    "This CLI runs on the Mac; build hosts are reached over SSH.",
  );
  if (command === "prune" || command === "rollback") {
    requireState(
      idle,
      "Restart interrupts agent turns and terminals. Confirm all selected hosts are idle with --confirm-idle. No host was changed.",
    );
  }
  const cfg = await config();
  if (command === "release") {
    await release(cfg, buildHost);
    return;
  }
  const published = await releases();
  if (command === "status") {
    console.log(
      JSON.stringify({
        forkReleases: published.map((item) => ({ tag: item.tag_name, draft: item.draft })),
      }),
    );
    let failed = false;
    for (const [name, host] of Object.entries(cfg.hosts)) {
      try {
        console.log(JSON.stringify({ host: name, ...(await snapshot(host)) }));
      } catch (error) {
        failed = true;
        console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failed) {
      throw new Refusal("One or more host statuses could not be read.", 1);
    }
    return;
  }
  const selected = all ? Object.keys(cfg.hosts) : [hostName!];
  requireState(
    selected.every((name) => Object.hasOwn(cfg.hosts, name)),
    "Unknown configured host.",
  );
  const releaseInfo = currentRelease(published);
  const current = version(releaseInfo.tag_name.slice(1));
  const work: Array<{ name: string; host: Host; before: Snapshot; target: string }> = [];
  for (const name of selected) {
    const host = cfg.hosts[name]!;
    const before = await snapshot(host);
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
        compareVersions(to, current) < 0,
        "Rollback target must be older than the active release.",
      );
      let receipt: ReleaseReceipt;
      try {
        receipt = migrationReceipt(releaseInfo);
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
  let completed = 0;
  for (const item of work) {
    try {
      const result = await remote(item.host, {
        action: command as "prune" | "rollback",
        version: item.target,
        expected: item.before,
        migrationsUnchanged: command === "rollback",
        confirmIdle: idle,
      });
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof Refusal && error.exitCode !== 255 ? error.exitCode : 1;
});
