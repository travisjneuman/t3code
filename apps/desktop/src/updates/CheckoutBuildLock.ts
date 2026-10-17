import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// One desktop artifact build per checkout. Two at once overwrite each other's
// dist output, and a source update merging mid-build changes the code being
// built. scripts/build-desktop-artifact.ts holds it; local source updates check
// it. `release/` is gitignored.
const LOCK_FILE = NodePath.join("release", ".desktop-build.lock");
// A build that crashed leaves its lock behind. Past this age, a live process
// with the recorded pid is an unrelated one that reused it.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export const checkoutBuildLockPath = (repoRoot: string): string =>
  NodePath.join(repoRoot, LOCK_FILE);

const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // The process exists but belongs to another user.
    return hasErrorCode(error, "EPERM");
  }
};

/** The pid of the live build holding the checkout, or undefined when none does. */
export function findCheckoutBuild(repoRoot: string): number | undefined {
  const lockPath = checkoutBuildLockPath(repoRoot);
  let text: string;
  let modifiedAt: number;
  try {
    text = NodeFS.readFileSync(lockPath, "utf8");
    modifiedAt = NodeFS.statSync(lockPath).mtimeMs;
  } catch {
    return undefined;
  }
  const pid = Number(text.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0 || Date.now() - modifiedAt > STALE_AFTER_MS) {
    return undefined;
  }
  return isRunning(pid) ? pid : undefined;
}

export type CheckoutBuildLock =
  | { readonly acquired: true; readonly release: () => void }
  | { readonly acquired: false; readonly holder: number | undefined };

/**
 * Takes the checkout's build lock, replacing one left by a build that is gone.
 * The pid is written before the lock appears (a hard link), so a reader never
 * sees an empty lock and mistakes it for a stale one.
 */
export function acquireCheckoutBuildLock(repoRoot: string): CheckoutBuildLock {
  const lockPath = checkoutBuildLockPath(repoRoot);
  const ownPid = String(process.pid);
  const pendingPath = `${lockPath}.${ownPid}`;
  NodeFS.mkdirSync(NodePath.dirname(lockPath), { recursive: true });
  NodeFS.writeFileSync(pendingPath, ownPid);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        NodeFS.linkSync(pendingPath, lockPath);
        const release = () => {
          try {
            if (NodeFS.readFileSync(lockPath, "utf8").trim() === ownPid) {
              NodeFS.rmSync(lockPath, { force: true });
            }
          } catch {
            // Already gone.
          }
        };
        return { acquired: true, release };
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
      }
      const holder = findCheckoutBuild(repoRoot);
      if (holder !== undefined) return { acquired: false, holder };
      NodeFS.rmSync(lockPath, { force: true });
    }
    // Another build replaced the same stale lock first.
    return { acquired: false, holder: findCheckoutBuild(repoRoot) };
  } finally {
    NodeFS.rmSync(pendingPath, { force: true });
  }
}
