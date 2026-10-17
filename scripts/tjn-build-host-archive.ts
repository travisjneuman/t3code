#!/usr/bin/env node
// Fork add-on: build native host archives without changing the checkout's release identity.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Mirror apps/desktop/src/updates/LocalSourceUpdates.ts: stamp only these working-tree
// manifests, then restore their original contents. A clean preflight makes the saved
// bytes equivalent to its index restore, without a checkout command or index mutation.
const RELEASE_PACKAGE_FILES = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;
const PACKAGE_VERSION_PATTERN = /("version":\s*")[^"]*(")/u;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.\d{8}\.(0|[1-9]\d*))?$/u;
const USAGE =
  "Usage: node scripts/tjn-build-host-archive.ts --version V --expect-sha SHA --out <dir>";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function physicalPath(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const parent = path.dirname(target);
    requireState(parent !== target, "Cannot resolve the output directory.");
    return path.join(await physicalPath(parent), path.basename(target));
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      "expect-sha": { type: "string" },
      out: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const version = values.version;
  const expectedSha = values["expect-sha"];
  requireState(
    version && VERSION_PATTERN.test(version),
    `${USAGE}\nExpected an exact stable or nightly version.`,
  );
  requireState(
    expectedSha && /^[a-f0-9]{40}$/u.test(expectedSha),
    `${USAGE}\nExpected a full lowercase commit SHA.`,
  );
  requireState(
    values.out && path.isAbsolute(values.out),
    `${USAGE}\n--out must be an absolute cache directory.`,
  );
  requireState(
    (process.platform === "win32" || process.platform === "linux") && process.arch === "x64",
    "Build host must be native Windows x64 or Linux x64.",
  );

  const platform = process.platform === "win32" ? "win" : "linux";
  const platformKey = `${process.platform}-x64`;
  const extension = platform === "win" ? ".exe" : "";
  const rustTarget = platform === "win" ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-gnu";
  const outputDir = path.resolve(values.out);
  const realRepoRoot = await fs.realpath(repoRoot);
  const realOutputDir = await physicalPath(outputDir);
  requireState(
    !contains(realRepoRoot, realOutputDir) && !contains(realOutputDir, realRepoRoot),
    "Output must be outside the checkout, not an ancestor of it or a link into it.",
  );
  // Match cliArchiveFileName in scripts/build-cli-archive.ts without loading its
  // workspace dependencies before vp i has installed them.
  const archive = path.join(
    outputDir,
    `t3-${version}-${platformKey}.${platform === "win" ? "zip" : "tar.gz"}`,
  );
  requireState(
    !(await exists(archive)),
    "The requested archive already exists; refusing to overwrite it.",
  );

  let interrupted: NodeJS.Signals | undefined;
  const onInterrupt = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
    console.error("Build interrupted; waiting for the current command before restoring manifests.");
  };
  const onSigint = () => onInterrupt("SIGINT");
  const onSigterm = () => onInterrupt("SIGTERM");

  async function run(
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; capture?: boolean; cleanup?: boolean } = {},
  ): Promise<string> {
    if (interrupted && !options.cleanup) {
      throw new Error(`Build interrupted by ${interrupted}.`);
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: repoRoot,
        env: options.env ?? process.env,
        stdio: ["ignore", options.capture ? "pipe" : "inherit", "inherit"],
        shell: false,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let oversized = false;
      child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          oversized = true;
        } else {
          chunks.push(chunk);
        }
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code !== 0) {
          reject(
            new Error(`${path.basename(command)} exited ${code ?? signal ?? "without a status"}.`),
          );
        } else if (interrupted && !options.cleanup) {
          reject(new Error(`Build interrupted by ${interrupted}.`));
        } else if (oversized) {
          reject(
            new Error("Command output exceeded the capture limit; refusing incomplete output."),
          );
        } else {
          resolve(Buffer.concat(chunks).toString("utf8").trim());
        }
      });
    });
  }

  const git = (args: string[], cleanup = false) => run("git", args, { capture: true, cleanup });
  async function requireCleanCheckout(cleanup = false) {
    requireState(
      (await git(["status", "--porcelain", "--untracked-files=all"], cleanup)) === "",
      "Checkout is dirty; pending changes were preserved.",
    );
    requireState(
      (await git(["rev-parse", "HEAD"], cleanup)) === expectedSha,
      "Checkout HEAD does not match --expect-sha.",
    );
  }

  const originals = new Map<string, Buffer>();
  const failures: unknown[] = [];
  let started = false;
  let sha256: string | undefined;
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    await requireCleanCheckout();
    started = true;
    const viteConfig = await fs.readFile(path.join(repoRoot, "apps/server/vite.config.ts"), "utf8");
    const seaNodeVersion = /^const SEA_NODE_VERSION = ["'](\d+\.\d+\.\d+)["'];?$/mu.exec(
      viteConfig,
    )?.[1];
    requireState(seaNodeVersion, "Cannot read SEA_NODE_VERSION from apps/server/vite.config.ts.");

    await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
    requireState(
      (await fs.realpath(outputDir)) === realOutputDir,
      "Output directory changed while preparing the build.",
    );
    const scratch = await fs.mkdtemp(path.join(outputDir, "build-"));
    const cargoTargetDir = path.join(repoRoot, "native/resource-monitor/target");
    // Archive installs and smoke extraction use OS temp APIs. Keep that scratch
    // under the coordinator-owned cache, never the system temporary directory.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      APP_VERSION: version,
      // Empty values override ignored env files too, keeping the client single-origin.
      VITE_HTTP_URL: "",
      VITE_WS_URL: "",
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      CARGO_TARGET_DIR: cargoTargetDir,
      CARGO_BUILD_TARGET: rustTarget,
      CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2",
    };
    delete env.T3CODE_PACK_EXE;
    delete env.T3CODE_PACK_EXE_TARGET;

    async function vp(args: string[]) {
      if (platform === "win") {
        // PowerShell resolves vp.cmd as well as vp.exe without cmd.exe argument
        // interpolation. Only fixed build arguments enter this command string.
        const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
        const script = `$ErrorActionPreference = 'Stop'; & vp ${args.map(quote).join(" ")}; exit $LASTEXITCODE`;
        await run(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          { env },
        );
      } else {
        await run("vp", args, { env });
      }
    }

    await vp(["i"]);
    // Install may legitimately update a lockfile. Preserve it, but do not label
    // the resulting archive as a build of the requested clean commit.
    await requireCleanCheckout();
    for (const file of RELEASE_PACKAGE_FILES) {
      const target = path.join(repoRoot, file);
      const bytes = await fs.readFile(target);
      const text = bytes.toString("utf8");
      requireState(PACKAGE_VERSION_PATTERN.test(text), `Missing version in ${file}.`);
      originals.set(target, bytes);
      await fs.writeFile(target, text.replace(PACKAGE_VERSION_PATTERN, `$1${version}$2`));
    }

    await vp(["run", "--filter", "t3", "build"]);
    await vp(["run", "build:resource-monitor"]);
    // cli.ts invokes vp pack, which selects the managed Node version from this
    // environment variable. Never pass --target: Windows cross-downloads use tar.
    await run(process.execPath, ["apps/server/scripts/cli.ts", "build-exe"], {
      env: { ...env, VP_NODE_VERSION: seaNodeVersion },
    });
    const monitorDir = path.join(scratch, "resource-monitor");
    const monitorStage = path.join(monitorDir, platformKey);
    const monitorName = `t3-resource-monitor${extension}`;
    await fs.mkdir(monitorStage, { recursive: true });
    await fs.copyFile(
      path.join(cargoTargetDir, rustTarget, "release", monitorName),
      path.join(monitorStage, monitorName),
    );
    await run(
      process.execPath,
      [
        "scripts/build-cli-archive.ts",
        "--platform",
        platform,
        "--arch",
        "x64",
        "--version",
        version,
        "--resource-monitor-dir",
        monitorDir,
        "--output-dir",
        outputDir,
      ],
      { env },
    );
    await run(
      process.execPath,
      ["scripts/smoke-cli-archive.ts", "--archive", archive, "--expect-version", version],
      { env },
    );

    const stat = await fs.lstat(archive);
    requireState(
      stat.isFile() && stat.size > 0,
      "Build did not produce a regular, nonempty archive.",
    );
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) {
      hash.update(chunk);
    }
    sha256 = hash.digest("hex");
  } catch (error) {
    failures.push(error);
  } finally {
    // Restore every saved file even if stamping or an earlier restore failed.
    for (const [target, bytes] of originals) {
      try {
        await fs.writeFile(target, bytes);
      } catch (error) {
        failures.push(
          new Error(`Could not restore ${path.relative(repoRoot, target)}.`, { cause: error }),
        );
      }
    }
    if (started) {
      try {
        await requireCleanCheckout(true);
      } catch (error) {
        failures.push(error);
      }
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  if (interrupted) {
    failures.push(new Error(`Build interrupted by ${interrupted}.`));
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Host archive build failed; no success receipt was emitted.",
    );
  }
  requireState(sha256, "Build did not produce an archive checksum.");
  // This must remain the final stdout line: the coordinator reads it from its
  // build log, checks the transferred checksum, and removes the version cache.
  console.log(JSON.stringify({ archive, sha256 }));
}

main().catch((error: unknown) => {
  const errors = error instanceof AggregateError ? error.errors : [error];
  for (const failure of errors) {
    console.error(failure instanceof Error ? failure.message : String(failure));
  }
  process.exitCode = 1;
});
