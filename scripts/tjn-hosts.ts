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
import { beginRun, heldLocks, runSummary, type Journal, type Step } from "./lib/tjn-hosts/runs.ts";

const REPOSITORY = "travisjneuman/t3code";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = path.join(homedir(), ".config", "t3code-fork", "hosts.json");
const CACHE = path.join(homedir(), "Library", "Caches", "t3code-fork-release");
const PLATFORMS = ["win32-x64", "linux-x64"] as const;
const USAGE = `Usage: node scripts/tjn-hosts.ts release [--build-host name] [--dry-run]
       node scripts/tjn-hosts.ts status
       node scripts/tjn-hosts.ts prune <host>|--all --confirm-idle [--dry-run]
       node scripts/tjn-hosts.ts rollback <host> [--to version] --confirm-idle [--dry-run]
Exit codes: 0 success; 1 command/IO failure; 2 usage; 3 preflight refusal or locked host;
            4 maintenance/publication may be partial (inspect before continuing).
--dry-run runs only the read-only preflight and prints every step per host; it changes
nothing and does not need --confirm-idle. Changing runs lock each host they cover and keep a
phase journal under ~/Library/Application Support/t3code-fork/host-runs.
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
  builders: Array<{ platform: Platform; role: string }>;
  migrations: Record<string, boolean>;
}

type Platform = (typeof PLATFORMS)[number];
const hostPath = (host: Host) => (host.os === "win32" ? path.win32 : path.posix);
const archiveName = (v: string, platform: Platform) =>
  `t3-${v}-${platform}.${platform === "win32-x64" ? "zip" : "tar.gz"}`;
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

async function copyArchive(host: Host, v: string, destination: string) {
  const joined = hostPath(host)
    .join(host.cacheDir, v, archiveName(v, `${host.os}-x64`))
    .replaceAll("\\", "/");
  // Windows OpenSSH's SFTP resolves `C:/...` against the home directory; absolute drive paths need `/C:/...`.
  const source = host.os === "win32" ? `/${joined}` : joined;
  const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  // SFTP preserves archive bytes; native stdout piped through Windows PowerShell does not.
  await run(
    "sftp",
    [
      "-b",
      "-",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      host.ssh,
    ],
    { input: `get ${quote(source)} ${quote(destination)}\n` },
  );
}

interface ReleasePlan {
  v: string;
  tag: string;
  tagSha: string;
  sha: string;
  existing: Release[];
  skipped: string[];
  chosen: Array<{ platform: Platform; name: string; host: Host; ordinal: number }>;
  migrations: Record<string, boolean>;
  staging: string;
}

// Read-only: git, the GitHub listing and host inspection. Dry runs stop after this.
async function releasePreflight(cfg: HostConfig, override?: string): Promise<ReleasePlan> {
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
  requireState(
    !(await exists(staging)),
    `Mac staging directory ${staging} already exists; inspect and remove it deliberately before releasing.`,
  );
  return { v, tag, tagSha, sha, existing, skipped, chosen, migrations, staging };
}

// The exact argv the run executes; dry runs and the journal print the same arrays.
function publication(p: ReleasePlan) {
  const files = p.chosen.map((build) => path.join(p.staging, archiveName(p.v, build.platform)));
  const sums = path.join(p.staging, "SHA256SUMS");
  const notesFile = path.join(p.staging, "release-notes.md");
  return {
    sums,
    notesFile,
    push: ["push", "origin", `refs/tags/${p.tag}`],
    create: [
      "release",
      "create",
      p.tag,
      "--repo",
      REPOSITORY,
      "--prerelease",
      "--verify-tag",
      "--title",
      `T3 Code host release ${p.v}`,
      "--notes-file",
      notesFile,
      ...files,
      sums,
    ],
    remove: p.existing.map((old) => [
      "release",
      "delete",
      old.tag_name,
      "--repo",
      REPOSITORY,
      "--yes",
    ]),
  };
}

function releaseSteps(p: ReleasePlan): Step[] {
  const pub = publication(p);
  const unpublished = "Nothing was published.";
  return [
    {
      host: null,
      phase: "stage",
      mutates: true,
      does: [`mkdir -p ${CACHE}`, `mkdir ${p.staging}`],
      ifStopped: unpublished,
      leaves: `the Mac staging directory ${p.staging}`,
    },
    ...p.chosen.flatMap(({ name, host, platform }): Step[] => {
      const hp = hostPath(host);
      const cache = hp.join(host.cacheDir, p.v);
      return [
        {
          host: name,
          phase: "build",
          mutates: true,
          does: [
            remoteShown(host, { action: "build", version: p.v, sha: p.sha }),
            `on host, in ${host.checkout}: git fetch origin main; git merge --ff-only ${p.sha}`,
            `on host: mkdir ${cache}; at lowered priority, logging to ${hp.join(cache, "build.log")}: ${shown([...host.node, "scripts/tjn-build-host-archive.ts", "--version", p.v, "--expect-sha", p.sha, "--out", cache])}`,
          ],
          ifStopped: `${name}'s version cache ${cache} is retained for inspection; release refuses to reuse it. ${unpublished}`,
          leaves: `${name}'s version cache ${cache}`,
        },
        {
          host: name,
          phase: "transfer",
          mutates: true,
          does: [
            `sftp -b - ${host.ssh}: get ${hp.join(cache, archiveName(p.v, platform))} ${path.join(p.staging, archiveName(p.v, platform))}`,
            "compare its SHA-256 with the builder receipt",
          ],
          ifStopped: `The local copy may be partial. ${unpublished}`,
        },
      ];
    }),
    {
      host: null,
      phase: "notes",
      mutates: true,
      does: [
        `write ${pub.sums} and ${pub.notesFile}`,
        "recheck that the checkout and upstream tag did not change",
      ],
      ifStopped: unpublished,
    },
    {
      host: null,
      phase: "push-tag",
      mutates: true,
      does: [shown(["git", ...pub.push])],
      ifStopped: `The upstream tag may now be on origin; preflight accepts that identical tag. ${unpublished}`,
    },
    {
      host: null,
      phase: "publish",
      mutates: true,
      final: true,
      does: [shown(["gh", ...pub.create])],
      ifStopped: "The release may exist, possibly incomplete; inspect the fork releases.",
    },
    {
      host: null,
      phase: "retention",
      mutates: true,
      does: [
        "recheck that only this release was added",
        ...pub.remove.map((args) => shown(["gh", ...args])),
      ],
      ifStopped: "Some older releases may remain; their tags are kept either way.",
    },
    ...p.chosen.map(({ name, host }): Step => ({
      host: name,
      phase: "remove-cache",
      mutates: true,
      does: [
        remoteShown(host, { action: "remove-cache", version: p.v }),
        `on host: rm -r ${hostPath(host).join(host.cacheDir, p.v)}`,
      ],
      ifStopped: `${name}'s version cache may remain.`,
    })),
    {
      host: null,
      phase: "remove-staging",
      mutates: true,
      does: [`rm -r ${p.staging}`],
      ifStopped: "The Mac staging directory may remain.",
    },
  ];
}

async function release(p: ReleasePlan, journal: Journal) {
  const pub = publication(p);
  await journal.step(null, "stage", async () => {
    await fs.mkdir(CACHE, { recursive: true, mode: 0o700 });
    requireState(
      path.resolve(await fs.realpath(CACHE)) === path.resolve(CACHE),
      "Mac release cache traverses a link.",
    );
    await fs.mkdir(p.staging, { mode: 0o700 });
  });
  const results = await Promise.allSettled(
    p.chosen.map(async (build) => {
      const name = archiveName(p.v, build.platform);
      const sha256 = await journal.step(build.name, "build", async () => {
        const result = await remote(build.host, { action: "build", version: p.v, sha: p.sha });
        requireState(
          record(result) &&
            typeof result.archive === "string" &&
            typeof result.sha256 === "string" &&
            /^[a-f0-9]{64}$/.test(result.sha256),
          "Invalid host builder receipt.",
        );
        requireState(
          result.archive === hostPath(build.host).join(build.host.cacheDir, p.v, name),
          "Builder returned an unexpected archive path.",
        );
        return result.sha256;
      });
      const destination = path.join(p.staging, name);
      await journal.step(build.name, "transfer", async () => {
        await copyArchive(build.host, p.v, destination);
        requireState(
          (await hashFile(destination)) === sha256,
          "Transferred archive differs from the host checksum.",
        );
      });
      return { ...build, destination, archive: name, sha256 };
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
  const receipt: ReleaseReceipt = {
    schemaVersion: 1,
    forkSha: p.sha,
    upstreamTag: p.tag,
    builders: built.map((build) => ({
      platform: build.platform,
      role: build.ordinal === 1 ? "primary" : `fallback-${build.ordinal - 1}`,
    })),
    migrations: p.migrations,
  };
  const notes = [
    `Fork SHA: ${p.sha}`,
    `Upstream nightly: ${p.tag} (${p.tagSha})`,
    ...receipt.builders.map((builder) => `${builder.platform}: ${builder.role} builder`),
    ...Object.entries(p.migrations).map(
      ([from, changed]) =>
        `Upstream migrations since ${from}: ${changed ? "changed; automated rollback refused, manual restore needs owner's go" : "unchanged"}.`,
    ),
    "After pruning a migrated release, fix forward. This tool never restores live userdata.",
    `<!-- t3-host-release ${JSON.stringify(receipt)} -->`,
  ].join("\n\n");
  await journal.step(null, "notes", async () => {
    await fs.writeFile(
      pub.sums,
      built.map((build) => `${build.sha256}  ${build.archive}\n`).join(""),
      {
        flag: "wx",
      },
    );
    await fs.writeFile(pub.notesFile, notes, { flag: "wx" });
    requireState(
      (await git("status", "--porcelain")) === "" && (await git("rev-parse", "HEAD")) === p.sha,
      "Mac checkout changed during the build; publication refused.",
    );
    requireState(
      (await git("rev-parse", `refs/tags/${p.tag}`)) === p.tagSha,
      "Upstream tag changed during the build; publication refused.",
    );
  });
  try {
    await journal.step(null, "push-tag", () => git(...pub.push));
    await journal.step(null, "publish", () => gh(...pub.create));
    await journal.step(null, "retention", async () => {
      const afterPublish = await releases();
      requireState(
        afterPublish.length === p.existing.length + 1 &&
          afterPublish.some((item) => item.tag_name === p.tag && !item.draft) &&
          afterPublish.every(
            (item) =>
              item.tag_name === p.tag ||
              p.existing.some((old) => old.tag_name === item.tag_name && old.draft === item.draft),
          ),
        "Release inventory changed concurrently; retention was not performed.",
      );
      for (const args of pub.remove) {
        await gh(...args);
      }
    });
    for (const build of built) {
      await journal.step(build.name, "remove-cache", () =>
        remote(build.host, { action: "remove-cache", version: p.v }),
      );
    }
    await journal.step(null, "remove-staging", () => fs.rm(p.staging, { recursive: true }));
  } catch (error) {
    throw new Refusal(
      `Publication/retention may be partial; inspect the fork release and named version caches before continuing. No retry or repair was attempted. ${error instanceof Error ? error.message : String(error)}`,
      4,
    );
  }
  console.log(`Published ${p.tag}; retained tags, removed other releases and build caches.`);
  if (p.skipped.length > 0) {
    console.log(`Unreachable hosts skipped (not validated or changed): ${p.skipped.join(", ")}`);
  }
  console.log(
    "Use each host's Update; use Update everything only after every connected host has the intended release source.",
  );
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

type MaintenanceCommand = "prune" | "rollback";
interface Maintenance {
  name: string;
  host: Host;
  before: Snapshot;
  target: string;
}

// Read-only: the GitHub listing and host inspection. Dry runs stop after this.
async function maintenancePreflight(
  command: MaintenanceCommand,
  cfg: HostConfig,
  selected: string[],
  target: string | undefined,
): Promise<Maintenance[]> {
  const releaseInfo = currentRelease(await releases());
  const current = version(releaseInfo.tag_name.slice(1));
  const work: Maintenance[] = [];
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
  let hostName: string | undefined;
  let buildHost: string | undefined;
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
      (command === "release" || command === "prune" || command === "rollback") &&
      !dryRun
    ) {
      dryRun = true;
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
  if ((command === "prune" || command === "rollback") && !dryRun) {
    requireState(
      idle,
      "Restart interrupts agent turns and terminals. Confirm all selected hosts are idle with --confirm-idle. No host was changed.",
    );
  }
  const cfg = await config();
  if (command === "release") {
    const hosts = Object.keys(cfg.hosts);
    if (dryRun) {
      const plan = await releasePreflight(cfg, buildHost);
      await printDryRun(
        [
          `release ${plan.tag} from ${plan.sha}`,
          ...plan.chosen.map(
            (build) =>
              `${build.platform}: ${build.name} (${build.ordinal === 1 ? "primary" : `fallback-${build.ordinal - 1}`})`,
          ),
          ...Object.entries(plan.migrations).map(
            ([from, changed]) =>
              `Upstream migrations since ${from}: ${changed ? "changed" : "unchanged"}`,
          ),
          ...(plan.skipped.length > 0 ? [`Unreachable, skipped: ${plan.skipped.join(", ")}`] : []),
        ],
        hosts,
        releaseSteps(plan),
      );
      return;
    }
    // Every host is locked: preflight compares all of them, and builders are chosen among them.
    await changing("release", hosts, "whole", async (journal) => {
      const plan = await journal.step(null, "preflight", () => releasePreflight(cfg, buildHost));
      journal.plan(releaseSteps(plan));
      await release(plan, journal);
    });
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
