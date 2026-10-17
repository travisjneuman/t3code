/**
 * Fork add-on: windows taskkill partial success. `taskkill /T /F` exits 128
 * when a descendant is already exiting as the tree is walked ("The operation
 * attempted is not supported", "There is no running instance of the task"),
 * even though the leader was terminated. A non-zero exit therefore still counts
 * as success once every process taskkill named is gone, which is the proof
 * upstream's exit-code check stands in for.
 *
 * @module provider-acp/windowsTaskkillExit
 */
import * as Effect from "effect/Effect";

const POLL_INTERVAL = "50 millis";
const POLL_ATTEMPTS = 20;

/** Only "PID <n>" tokens: other numbers in the message are never processes. */
const namedPids = (output: string): Set<number> =>
  new Set(Array.from(output.matchAll(/\bPID\s+(\d+)/g), (match) => Number(match[1])));

/** ESRCH alone proves the process is gone; EPERM and anything else mean it may still run. */
const pidExited = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
};

/**
 * True when taskkill's output names `leaderPid` and every PID it names, except
 * this server's own, has exited within about a second. Output that never names
 * the leader (process not found, access denied, an unknown format) stays a
 * failure, so a missing leader still proves nothing about its descendants.
 */
export const windowsTaskkillTreeExited = Effect.fn("windowsTaskkillTreeExited")(function* (
  leaderPid: number,
  output: string,
) {
  const pids = namedPids(output);
  if (!pids.has(leaderPid)) return false;
  pids.delete(process.pid);
  for (let attempt = 0; ; attempt++) {
    if (Array.from(pids).every(pidExited)) return true;
    if (attempt >= POLL_ATTEMPTS) return false;
    yield* Effect.sleep(POLL_INTERVAL);
  }
});
