#!/usr/bin/env node
// Fork add-on: deliberate Mac-owned host releases, without hosted build automation.
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  deliveryDir,
  hashFile,
  isUpdateTarget,
  powershellArgs,
  psQuote,
  record,
  Refusal,
  releaseVersion,
  requireState,
  run,
  sftp,
  sftpPath,
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
const USAGE = `Usage: node scripts/tjn-hosts.ts release [--build-host name] [--expect-sha sha] [--dry-run]
       node scripts/tjn-hosts.ts status
       node scripts/tjn-hosts.ts stage <host> [--dry-run]
       node scripts/tjn-hosts.ts prune <host>|--all --confirm-idle [--dry-run]
       node scripts/tjn-hosts.ts rollback <host> [--to version] --confirm-idle [--dry-run]
Exit codes: 0 success; 1 command/IO failure; 2 usage; 3 preflight refusal or locked host;
            4 maintenance/publication may be partial (inspect before continuing).
--dry-run runs only the read-only preflight and prints every step per host; it changes
nothing and does not need --confirm-idle. Changing runs lock each host they cover and keep a
phase journal under ~/Library/Application Support/t3code-fork/host-runs.
Unreachable hosts are reported and skipped during release preflight only.
A host runs \`<nightly>+<fork build>\`, so a new fork commit at the same upstream nightly is
released too; it replaces that nightly's release. Releasing a commit already published is a
no-op. --expect-sha refuses unless the checkout is at that commit (the Mac app passes the commit
it pushed). Only the host tool files must be clean; the rest of the checkout may hold other work.
A host with stageFrom gets each release from that host over SSH after publication; stage
repeats that for the published release. Its in-app Update then installs without downloading.
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
  for (const [name, raw] of Object.entries(hosts)) {
    if (!record(raw) || raw.stageFrom === undefined) {
      continue;
    }
    const source =
      typeof raw.stageFrom === "string" && Object.hasOwn(hosts, raw.stageFrom)
        ? hosts[raw.stageFrom]
        : undefined;
    requireState(
      raw.stageFrom !== name &&
        record(source) &&
        source.os === raw.os &&
        source.stageFrom === undefined,
      "stageFrom must name another configured host with the same OS that downloads its own releases.",
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

// remoteSource() sends these to every host, so they must be exactly the released commit's.
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

async function copyArchive(host: Host, v: string, destination: string) {
  const source = hostPath(host).join(host.cacheDir, v, archiveName(v, `${host.os}-x64`));
  await sftp(
    host.ssh,
    [["get", sftpPath(host.os, source), destination]],
    path.dirname(destination),
  );
}

interface Delivery {
  name: string;
  host: Host;
  source: string;
  sourceHost: Host;
}

// The source downloads the published archive itself, so delivery never depends on which
// host built it or on the Mac's transfer cache.
function deliverySteps(v: string, deliveries: Delivery[]): Step[] {
  return deliveries.flatMap(({ name, host, source, sourceHost }): Step[] => {
    const archive = archiveName(v, `${host.os}-x64`);
    const sourceCache = hostPath(sourceHost).join(sourceHost.cacheDir, deliveryDir(v));
    const targetCache = hostPath(host).join(host.cacheDir, deliveryDir(v));
    const installedDir = hostPath(host).join(host.t3Home, "runtime", "versions", v);
    return [
      {
        host: source,
        phase: `deliver:${name}`,
        mutates: true,
        does: [
          remoteShown(sourceHost, { action: "deliver", version: v, to: name }),
          `on host: download ${archive} and SHA256SUMS from the fork release v${releaseVersion(v)} into ${sourceCache}; check its SHA-256`,
          `on host: sftp -b - ${host.ssh}: mkdir ${targetCache}; put ${archive} there; then rm -r ${sourceCache}`,
        ],
        ifStopped: `${name}'s delivery cache ${targetCache} may remain.`,
        leaves: `${name}'s delivery cache ${targetCache}`,
      },
      {
        host: name,
        phase: "install",
        mutates: true,
        final: true,
        does: [
          remoteShown(host, { action: "install", version: v }),
          `on host: recheck the SHA-256; extract into ${installedDir} with .install-complete; rm -r ${targetCache}`,
        ],
        ifStopped: `${installedDir} is complete or absent; ${targetCache} may remain.`,
      },
    ];
  });
}

async function deliverReleases(v: string, deliveries: Delivery[], journal: Journal) {
  for (const { name, host, source, sourceHost } of deliveries) {
    const sha256 = await journal.step(source, `deliver:${name}`, async () => {
      const result = await remote(sourceHost, { action: "deliver", version: v, to: host });
      requireState(
        record(result) &&
          result.archive === archiveName(v, `${host.os}-x64`) &&
          typeof result.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(result.sha256),
        "Invalid delivery receipt.",
      );
      return result.sha256;
    });
    await journal.step(name, "install", () =>
      remote(host, { action: "install", version: v, sha256 }),
    );
    console.log(`${name}: ${v} staged from ${source}; its Update installs it without downloading.`);
  }
}

interface ReleasePlan {
  v: string;
  /** What hosts run and install: `<v>+<first 12 of sha>`. */
  id: string;
  tag: string;
  tagSha: string;
  sha: string;
  existing: Release[];
  /** This nightly's earlier release, from another fork commit. */
  replaced: Release | undefined;
  skipped: string[];
  chosen: Array<{ platform: Platform; name: string; host: Host; ordinal: number }>;
  migrations: Record<string, boolean>;
  staging: string;
  deliveries: Delivery[];
}

// Read-only: git, the GitHub listing and host inspection. Dry runs stop after this.
// A string result means this commit is already published and there is nothing to do.
async function releasePreflight(
  cfg: HostConfig,
  override?: string,
  expectSha?: string,
): Promise<ReleasePlan | string> {
  if (override) {
    requireState(
      PLATFORMS.some((platform) => cfg.buildHosts[platform].includes(override)),
      "--build-host must name a configured platform build host.",
    );
  }
  requireState((await git("branch", "--show-current")) === "main", "Mac checkout is not on main.");
  requireState(await shippedFilesAt("HEAD"), "The Mac checkout's host tool files have changes.");
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
    expectSha === undefined || sha === expectSha,
    "The checkout moved past the requested commit; release the newer commit instead.",
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
  const id = `${v}+${sha.slice(0, 12)}`;
  const existing = await releases();
  const replaced = existing.find((item) => item.tag_name === tag);
  if (replaced !== undefined) {
    requireState(!replaced.draft, "A draft fork release uses this tag; inspect it first.");
    if (releaseReceipt(replaced).forkSha === sha) {
      return `${tag} is already published from ${sha}; nothing to release.`;
    }
  }

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
      isUpdateTarget(id, state.state.activeVersion),
      `${name} already runs ${state.state.activeVersion}, this build or a newer one.`,
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
    const fromTag = `refs/tags/v${releaseVersion(from)}`;
    const baseline = await git("rev-parse", `${fromTag}^{commit}`);
    requireState(
      (await git("ls-remote", "upstream", fromTag)).split(/\s/)[0] === baseline,
      "Migration baseline tag differs from upstream or is unavailable.",
    );
    const changed = await git(
      "diff",
      "--name-only",
      fromTag,
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
  const deliveries: Delivery[] = [];
  for (const [name, host] of Object.entries(cfg.hosts)) {
    const source = host.stageFrom;
    if (source === undefined) {
      continue;
    }
    if (!snapshots.has(name) || !snapshots.has(source)) {
      console.error(`${name}: it or ${source} is unreachable; afterwards run \`stage ${name}\`.`);
    } else if (snapshots.get(name)!.versions.includes(id)) {
      console.error(`${name}: ${id} is already installed there; nothing to deliver.`);
    } else {
      deliveries.push({ name, host, source, sourceHost: cfg.hosts[source]! });
    }
  }
  return {
    v,
    id,
    tag,
    tagSha,
    sha,
    existing,
    replaced,
    skipped,
    chosen,
    migrations,
    staging,
    deliveries,
  };
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
      `T3 Code host release ${p.id}`,
      "--notes-file",
      notesFile,
      ...files,
      sums,
    ],
    // Deleting a release keeps its tag, which is upstream's.
    replace:
      p.replaced === undefined
        ? undefined
        : ["release", "delete", p.tag, "--repo", REPOSITORY, "--yes"],
    remove: p.existing
      .filter((old) => old.tag_name !== p.tag)
      .map((old) => ["release", "delete", old.tag_name, "--repo", REPOSITORY, "--yes"]),
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
    ...(pub.replace === undefined
      ? []
      : [
          {
            host: null,
            phase: "replace",
            mutates: true,
            does: [shown(["gh", ...pub.replace])],
            ifStopped: `${p.tag}'s earlier release may be gone and the new one not yet published; inspect the fork releases.`,
          },
        ]),
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
    ...deliverySteps(p.id, p.deliveries),
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
    `Host runtime: ${p.id}`,
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
    // The Mac app may build and commit in this checkout meanwhile; the hosts built p.sha.
    requireState(
      (await shippedFilesAt(p.sha)) &&
        (await git("merge-base", "--is-ancestor", p.sha, "HEAD").then(
          () => true,
          () => false,
        )),
      "Mac checkout changed the host tool files or left the released commit; publication refused.",
    );
    requireState(
      (await git("rev-parse", `refs/tags/${p.tag}`)) === p.tagSha,
      "Upstream tag changed during the build; publication refused.",
    );
  });
  try {
    await journal.step(null, "push-tag", () => git(...pub.push));
    if (pub.replace !== undefined) {
      const replace = pub.replace;
      await journal.step(null, "replace", () => gh(...replace));
    }
    await journal.step(null, "publish", () => gh(...pub.create));
    await journal.step(null, "retention", async () => {
      const afterPublish = await releases();
      requireState(
        afterPublish.length === p.existing.length + (p.replaced === undefined ? 1 : 0) &&
          afterPublish.some((item) => item.tag_name === p.tag && !item.draft) &&
          afterPublish.every(
            (item) =>
              (item.tag_name === p.tag && releaseReceipt(item).forkSha === p.sha) ||
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
  console.log(`Published ${p.id}; retained tags, removed other releases and build caches.`);
  try {
    await deliverReleases(p.id, p.deliveries, journal);
  } catch (error) {
    throw new Refusal(
      `Published ${p.tag}, but delivery did not finish: ${error instanceof Error ? error.message : String(error)}\nRemove any leftover delivery cache named below, then run \`stage <host>\`.`,
      1,
    );
  }
  if (p.skipped.length > 0) {
    console.log(`Unreachable hosts skipped (not validated or changed): ${p.skipped.join(", ")}`);
  }
  console.log(
    "The Mac app updates each connected fork host once it is idle; a host's Update in Settings → Connections does it now.",
  );
}

// Read-only: the GitHub listing, the target's snapshot and the source's reachability.
async function stagePreflight(cfg: HostConfig, name: string) {
  const host = cfg.hosts[name]!;
  const source = host.stageFrom;
  requireState(source !== undefined, "Host has no stageFrom; it downloads its own releases.");
  const v = releaseId(currentRelease(await releases()));
  const before = await snapshot(host);
  requireState(
    isUpdateTarget(v, before.state.activeVersion),
    "Host already runs the published fork release; nothing to stage.",
  );
  requireState(
    !before.versions.includes(v),
    "The published release is already installed on the host; apply it with its Update.",
  );
  const sourceHost = cfg.hosts[source]!;
  await remote(sourceHost, { action: "ready" });
  return { v, deliveries: [{ name, host, source, sourceHost }] };
}

// Refusals here come before any host is changed.
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

// Read-only: the GitHub listing and host inspection. Dry runs stop after this.
async function maintenancePreflight(
  command: MaintenanceCommand,
  cfg: HostConfig,
  selected: string[],
  target: string | undefined,
): Promise<Maintenance[]> {
  const releaseInfo = currentRelease(await releases());
  const current = releaseId(releaseInfo);
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
        receipt = releaseReceipt(releaseInfo);
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
  let expectSha: string | undefined;
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
      (command === "release" ||
        command === "prune" ||
        command === "rollback" ||
        command === "stage") &&
      !dryRun
    ) {
      dryRun = true;
    } else if (arg === "--build-host" && command === "release" && !buildHost) {
      buildHost = args.shift();
      if (!buildHost || buildHost.startsWith("-")) {
        throw new Refusal("--build-host needs a configured name.\n" + USAGE, 2);
      }
    } else if (arg === "--expect-sha" && command === "release" && !expectSha) {
      expectSha = args.shift();
      if (!expectSha || !/^[a-f0-9]{40}$/.test(expectSha)) {
        throw new Refusal("--expect-sha needs a full commit SHA.\n" + USAGE, 2);
      }
    } else if (arg === "--to" && command === "rollback" && !target) {
      target = args.shift();
      if (!target || target.startsWith("-")) {
        throw new Refusal("--to needs an exact version.\n" + USAGE, 2);
      }
    } else if (
      !arg.startsWith("-") &&
      (command === "prune" || command === "rollback" || command === "stage") &&
      !hostName
    ) {
      hostName = arg;
    } else {
      throw new Refusal(USAGE, 2);
    }
  }
  if (
    !command ||
    !["release", "status", "prune", "rollback", "stage"].includes(command) ||
    ((command === "prune" || command === "rollback") && all === Boolean(hostName)) ||
    (command === "stage" && !hostName)
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
      const plan = await releasePreflight(cfg, buildHost, expectSha);
      if (typeof plan === "string") {
        console.log(plan);
        return;
      }
      await printDryRun(
        [
          `release ${plan.id} from ${plan.sha}${plan.replaced === undefined ? "" : `, replacing ${plan.tag}'s release`}`,
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
      const plan = await journal.step(null, "preflight", () =>
        releasePreflight(cfg, buildHost, expectSha),
      );
      if (typeof plan === "string") {
        console.log(plan);
        return;
      }
      journal.plan(releaseSteps(plan));
      await release(plan, journal);
    });
    return;
  }
  if (command === "stage") {
    requireState(Object.hasOwn(cfg.hosts, hostName!), "Unknown configured host.");
    const source = cfg.hosts[hostName!]!.stageFrom;
    const locked = source === undefined ? [hostName!] : [source, hostName!];
    if (dryRun) {
      const plan = await stagePreflight(cfg, hostName!);
      await printDryRun(
        [`stage ${plan.v} onto ${hostName} from ${source}`],
        locked,
        deliverySteps(plan.v, plan.deliveries),
      );
      return;
    }
    await changing("stage", locked, "whole", async (journal) => {
      const plan = await journal.step(null, "preflight", () => stagePreflight(cfg, hostName!));
      journal.plan(deliverySteps(plan.v, plan.deliveries));
      await deliverReleases(plan.v, plan.deliveries, journal);
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
