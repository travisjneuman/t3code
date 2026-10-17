// Fork add-on: Mac-side per-host run locks and phase journals for scripts/tjn-hosts.ts.
// Never part of the host payload; hosts keep their own state checks in remote.ts.
import { randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { homedir, hostname } from "node:os";
import * as path from "node:path";
import { record, Refusal } from "./remote.ts";

// Run state, not cache: clearing caches must not forget an interrupted run.
const RUN_STATE = path.join(
  homedir(),
  "Library",
  "Application Support",
  "t3code-fork",
  "host-runs",
);
const LOCKS = path.join(RUN_STATE, "locks");
const JOURNALS = path.join(RUN_STATE, "journal");
// Past this age a live PID is more likely hung or reused than a real run, and a lock written
// under another machine name (macOS renames itself across networks) is presumed abandoned.
const LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const KEEP_JOURNALS = 20;

export interface Step {
  host: string | null; // null is the Mac coordinator: git, gh and local staging.
  phase: string;
  mutates: boolean;
  does: string[];
  ifStopped: string;
  leaves?: string; // A leftover that blocks rerunning the whole command once this step started.
  final?: true; // Once done, the whole command must not be rerun.
  rerun?: string; // Reruns only this host while none of its changing steps started.
}
type Status = "pending" | "started" | "done" | "failed";
interface Phase extends Step {
  status: Status;
  at?: string;
}
interface JournalData {
  schemaVersion: 1;
  command: string;
  argv: string[];
  hosts: string[];
  rerun: "per-host" | "whole";
  pid: number;
  machine: string;
  startedAt: string;
  updatedAt: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  error?: string;
  phases: Phase[];
}
interface Owner {
  schemaVersion: 1;
  token: string;
  host: string;
  command: string;
  pid: number;
  machine: string;
  startedAt: string;
  journal: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;

function writeJson(file: string, value: unknown) {
  // Synchronous, so concurrent build steps never interleave writes of one journal.
  const temporary = `${file}.${process.pid}.tmp`;
  fsSync.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flush: true,
  });
  fsSync.renameSync(temporary, file);
}
async function readJson(file: string): Promise<{ missing: true } | { value: unknown }> {
  try {
    return { value: JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (error) {
    return errno(error) === "ENOENT" ? { missing: true } : { value: undefined };
  }
}
function isOwner(value: unknown): value is Owner {
  return (
    record(value) &&
    value.schemaVersion === 1 &&
    typeof value.token === "string" &&
    typeof value.host === "string" &&
    typeof value.command === "string" &&
    Number.isSafeInteger(value.pid) &&
    typeof value.machine === "string" &&
    typeof value.startedAt === "string" &&
    Number.isFinite(Date.parse(value.startedAt)) &&
    typeof value.journal === "string"
  );
}
function isJournal(value: unknown): value is JournalData {
  return (
    record(value) &&
    value.schemaVersion === 1 &&
    typeof value.command === "string" &&
    typeof value.status === "string" &&
    Number.isSafeInteger(value.pid) &&
    typeof value.machine === "string" &&
    typeof value.startedAt === "string" &&
    Array.isArray(value.hosts) &&
    value.hosts.every((host) => typeof host === "string") &&
    Array.isArray(value.phases) &&
    value.phases.every(
      (phase) =>
        record(phase) &&
        (phase.host === null || typeof phase.host === "string") &&
        typeof phase.phase === "string" &&
        typeof phase.status === "string" &&
        typeof phase.mutates === "boolean" &&
        Array.isArray(phase.does) &&
        typeof phase.ifStopped === "string",
    )
  );
}
function running(machine: string, pid: number) {
  // Our own PID in an older record was reused from a run that is gone.
  if (machine !== hostname() || pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) === "EPERM";
  }
}
// A journal whose owner died without recording an outcome was interrupted, whatever it says.
const effectiveStatus = (data: JournalData) =>
  data.status === "running" && !running(data.machine, data.pid) ? "interrupted" : data.status;
const touched = (data: JournalData) =>
  data.phases.some((phase) => phase.mutates && phase.status !== "pending");

function advice(data: JournalData): string[] {
  const started = (phase: Phase) => phase.status !== "pending";
  if (!touched(data)) {
    return ["Nothing was changed; rerunning the same command is safe."];
  }
  if (data.rerun === "per-host") {
    return [
      "Rerun guidance:",
      ...data.hosts.flatMap((host) => {
        const phases = data.phases.filter((phase) => phase.host === host && phase.mutates);
        if (phases.length === 0) {
          return [];
        }
        if (phases.every((phase) => phase.status === "done")) {
          return [`  ${host}: finished; do not rerun it.`];
        }
        if (!phases.some(started)) {
          const rerun = phases.find((phase) => phase.rerun)?.rerun;
          return [`  ${host}: untouched; safe to rerun on its own${rerun ? `: ${rerun}` : "."}`];
        }
        return [`  ${host}: may be partial; read \`status\` before choosing recovery.`];
      }),
    ];
  }
  const final = data.phases.find((phase) => phase.final);
  if (final === undefined || final.status === "pending") {
    const leftovers = data.phases.flatMap((phase) =>
      started(phase) && phase.leaves ? [phase.leaves] : [],
    );
    return [
      leftovers.length > 0
        ? `Nothing was published. Before rerunning ${data.command}, inspect and deliberately remove whichever of these exist: ${leftovers.join("; ")}.`
        : `Nothing was published; rerunning ${data.command} is safe.`,
    ];
  }
  if (final.status !== "done") {
    return [`${final.phase} may be partial; inspect it and do not rerun ${data.command}.`];
  }
  const remaining = data.phases.filter((phase) => phase.mutates && phase.status !== "done");
  return [
    `${final.phase} completed; do not rerun ${data.command}.`,
    ...(remaining.length > 0
      ? [
          "After inspection, finish these by hand:",
          ...remaining.flatMap((phase) =>
            phase.does.map((line) => `  [${phase.host ?? "Mac"}] ${phase.phase}: ${line}`),
          ),
        ]
      : []),
  ];
}
function report(data: JournalData, file: string): string {
  const lines = [`Run journal (${data.command}, ${effectiveStatus(data)}): ${file}`];
  for (const host of new Set(data.phases.map((phase) => phase.host))) {
    const phases = data.phases.filter((phase) => phase.host === host);
    const named = (status: Status) =>
      phases.filter((phase) => phase.status === status).map((phase) => phase.phase);
    const parts: string[] = [];
    if (named("done").length > 0) {
      parts.push(`Completed ${named("done").join(", ")}.`);
    }
    for (const phase of phases) {
      if (phase.status === "started" || phase.status === "failed") {
        parts.push(
          `${phase.status === "failed" ? "Failed" : "Interrupted"} in ${phase.phase}: ${phase.ifStopped}`,
        );
      }
    }
    if (named("pending").length > 0) {
      parts.push(`Not reached: ${named("pending").join(", ")}.`);
    }
    lines.push(`  ${host ?? "Mac"}: ${parts.join(" ")}`);
  }
  return [...lines, ...advice(data)].join("\n");
}

export class Journal {
  readonly file: string;
  private readonly data: JournalData;
  constructor(file: string, data: JournalData) {
    this.file = file;
    this.data = data;
  }
  plan(steps: Step[]) {
    this.data.phases.push(...steps.map((step): Phase => ({ ...step, status: "pending" })));
    this.save();
  }
  async step<T>(host: string | null, phase: string, work: () => Promise<T>): Promise<T> {
    const entry = this.data.phases.find(
      (item) => item.host === host && item.phase === phase && item.status === "pending",
    );
    if (entry === undefined) {
      throw new Error(`Unplanned run step ${host ?? "Mac"}/${phase}; nothing was changed by it.`);
    }
    this.mark(entry, "started");
    try {
      const result = await work();
      this.mark(entry, "done");
      return result;
    } catch (error) {
      this.mark(entry, "failed");
      throw error;
    }
  }
  touched() {
    return touched(this.data);
  }
  succeed() {
    this.data.status = "succeeded";
    this.save();
  }
  fail(error: unknown) {
    this.data.status = "failed";
    this.data.error = message(error).slice(0, 4096);
    this.save();
  }
  report() {
    return report(this.data, this.file);
  }
  private mark(entry: Phase, status: Status) {
    entry.status = status;
    entry.at = new Date().toISOString();
    this.save();
  }
  save() {
    this.data.updatedAt = new Date().toISOString();
    writeJson(this.file, this.data);
  }
}

const lockFile = (host: string) =>
  // base64url never yields "/", "." or "..", so any inventory name is a safe file name.
  path.join(LOCKS, `${Buffer.from(host).toString("base64url")}.lock`);

async function lockOwners(): Promise<Array<{ file: string; owner: Owner }>> {
  let names: string[];
  try {
    names = await fs.readdir(LOCKS);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const owners: Array<{ file: string; owner: Owner }> = [];
  for (const name of names.filter((entry) => entry.endsWith(".lock")).sort()) {
    const file = path.join(LOCKS, name);
    const read = await readJson(file);
    if ("value" in read && isOwner(read.value)) {
      owners.push({ file, owner: read.value });
    }
  }
  return owners;
}
const describe = (owner: Owner) =>
  `\`${owner.command}\` (pid ${owner.pid} on ${owner.machine}, started ${owner.startedAt}, ${Math.max(0, Math.round((Date.now() - Date.parse(owner.startedAt)) / 60_000))} min ago)`;

async function reclaim(file: string, stale: Owner) {
  // Moving the file first means a run that took the lock after our read keeps it.
  const aside = `${file}.${randomBytes(8).toString("hex")}.stale`;
  try {
    await fs.rename(file, aside);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  const moved = await readJson(aside);
  if ("value" in moved && isOwner(moved.value) && moved.value.token === stale.token) {
    await fs.rm(aside);
    return;
  }
  try {
    await fs.link(aside, file);
  } finally {
    await fs.rm(aside, { force: true });
  }
  throw new Refusal(
    `${stale.host}: another run took its lock while a stale one was cleared; nothing was changed.`,
  );
}

async function clearStale(file: string, host: string) {
  const read = await readJson(file);
  if ("missing" in read) {
    return;
  }
  const holder = read.value;
  if (!isOwner(holder)) {
    throw new Refusal(
      `${host}: unreadable lock ${file}. Inspect it and remove it deliberately; nothing was changed.`,
    );
  }
  const age = Date.now() - Date.parse(holder.startedAt);
  const who = describe(holder);
  const sameMachine = holder.machine === hostname();
  if (running(holder.machine, holder.pid)) {
    throw new Refusal(
      age < LOCK_MAX_AGE_MS
        ? `${host} is locked by ${who}. Wait for that run to finish; nothing was changed.`
        : `${host} is locked by ${who}; its PID still runs after 12 hours, so the run is hung or the PID was reused. Check with \`ps -p ${holder.pid}\`, then remove ${file} deliberately. Nothing was changed.`,
    );
  }
  if (!sameMachine && age < LOCK_MAX_AGE_MS) {
    throw new Refusal(
      `${host} is locked by ${who}; that PID cannot be checked under this machine name. If no run is active, remove ${file} deliberately. Nothing was changed.`,
    );
  }
  const journal = await readJson(holder.journal);
  if (!("value" in journal) || !isJournal(journal.value)) {
    throw new Refusal(
      `${host} is locked by ${who}, which has exited; its journal ${holder.journal} is missing or unreadable, so an interrupted host change cannot be ruled out. Read \`status\`, then remove ${file} deliberately. Nothing was changed.`,
    );
  }
  const data = journal.value;
  if (data.phases.some((phase) => phase.mutates && phase.status === "started")) {
    throw new Refusal(
      `${host} is locked by ${who}, which exited during a changing step; a service may still be stopped or a remote step may still be running.\n${report(data, holder.journal)}\nRead \`status\`, then remove ${file} deliberately. Nothing was changed.`,
    );
  }
  await reclaim(file, holder);
  if (data.status === "running") {
    data.status = "interrupted";
    data.updatedAt = new Date().toISOString();
    writeJson(holder.journal, data);
  }
  console.error(`${host}: cleared a stale lock from ${who}; no changing step was in progress.`);
}

async function acquire(owner: Owner): Promise<string> {
  const file = lockFile(owner.host);
  const temporary = `${file}.${owner.token}.tmp`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // A hard link publishes the complete owner record atomically, or fails if a lock exists.
    await fs.writeFile(temporary, `${JSON.stringify(owner)}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    try {
      await fs.link(temporary, file);
      return file;
    } catch (error) {
      if (errno(error) !== "EEXIST") {
        throw error;
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
    await clearStale(file, owner.host);
  }
  throw new Refusal(`${owner.host}: another run claimed its lock first; nothing was changed.`);
}

function releaseLock(file: string, token: string) {
  try {
    const owner: unknown = JSON.parse(fsSync.readFileSync(file, "utf8"));
    if (record(owner) && owner.token === token) {
      fsSync.rmSync(file);
    }
  } catch {
    // A lock left behind names a finished journal, so the next run reclaims it as stale.
  }
}

async function retainJournals() {
  const referenced = new Set((await lockOwners()).map(({ owner }) => owner.journal));
  // Names start with a fixed-width UTC stamp, so lexical order is chronological.
  const names = (await fs.readdir(JOURNALS)).filter((name) => name.endsWith(".json")).sort();
  for (const name of names.slice(0, Math.max(0, names.length - (KEEP_JOURNALS - 1)))) {
    const file = path.join(JOURNALS, name);
    if (!referenced.has(file)) {
      await fs.rm(file, { force: true });
    }
  }
}

interface Run {
  journal: Journal;
  release(): void;
}

/** Locks every named host (all or none) and opens this run's journal. */
export async function beginRun(
  command: string,
  hosts: string[],
  rerun: JournalData["rerun"],
): Promise<Run> {
  await fs.mkdir(LOCKS, { recursive: true, mode: 0o700 });
  await fs.mkdir(JOURNALS, { recursive: true, mode: 0o700 });
  await retainJournals();
  const startedAt = new Date().toISOString();
  const file = path.join(JOURNALS, `${startedAt.replace(/[-:.]/g, "")}-${process.pid}.json`);
  const token = randomBytes(16).toString("hex");
  const held: string[] = [];
  const release = () => {
    for (const lock of held.splice(0)) {
      releaseLock(lock, token);
    }
  };
  const machine = hostname();
  const journal = new Journal(file, {
    schemaVersion: 1,
    command,
    argv: process.argv.slice(2),
    hosts: [...hosts],
    rerun,
    pid: process.pid,
    machine,
    startedAt,
    updatedAt: startedAt,
    status: "running",
    phases: [],
  });
  // Written before any lock, so a lock never names a journal that does not exist.
  journal.save();
  try {
    for (const host of [...hosts].sort()) {
      held.push(
        await acquire({
          schemaVersion: 1,
          token,
          host,
          command,
          pid: process.pid,
          machine,
          startedAt,
          journal: file,
        }),
      );
    }
  } catch (error) {
    release();
    // A refused run changed nothing; keep it out of the retained journals.
    fsSync.rmSync(file, { force: true });
    throw error;
  }
  return { journal, release };
}

export async function heldLocks(hosts?: string[]) {
  return (await lockOwners())
    .filter(({ owner }) => hosts === undefined || hosts.includes(owner.host))
    .map(({ file, owner }) => ({
      host: owner.host,
      command: owner.command,
      pid: owner.pid,
      machine: owner.machine,
      startedAt: owner.startedAt,
      holderRunning: owner.machine === hostname() ? running(owner.machine, owner.pid) : null,
      lock: file,
      journal: owner.journal,
    }));
}

/** Per host, the latest run that changed something or is still running, unless it succeeded. */
export async function runSummary() {
  let names: string[] = [];
  try {
    names = (await fs.readdir(JOURNALS)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (errno(error) !== "ENOENT") {
      throw error;
    }
  }
  const latest = new Map<string, { file: string; data: JournalData }>();
  for (const name of names) {
    const file = path.join(JOURNALS, name);
    const read = await readJson(file);
    if (!("value" in read) || !isJournal(read.value)) {
      continue;
    }
    const data = read.value;
    if (touched(data) || effectiveStatus(data) === "running") {
      for (const host of data.hosts) {
        latest.set(host, { file, data });
      }
    }
  }
  const unfinished = [...new Set(latest.values())]
    .filter(({ data }) => data.status !== "succeeded")
    .map(({ file, data }) => ({
      journal: file,
      command: data.command,
      status: effectiveStatus(data),
      startedAt: data.startedAt,
      hosts: data.hosts,
      stopped: data.phases
        .filter((phase) => phase.status === "started" || phase.status === "failed")
        .map((phase) => ({ host: phase.host, phase: phase.phase, status: phase.status })),
      ...(data.error === undefined ? {} : { error: data.error }),
    }));
  return { locks: await heldLocks(), unfinished };
}
