import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export function processIdentityFromStartTime(pid: number, startTime: string): string {
  return createHash("sha256").update(`${pid}:${startTime.trim()}`).digest("hex");
}

export function observeProcessStartTime(pid: number): string | undefined {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const observed = result.stdout.trim();
  return result.status === 0 && observed.length > 0 ? observed : undefined;
}

/** Hash the OS-observed process start time and PID to detect PID reuse. */
export function observeProcessIdentity(pid: number): string | undefined {
  const observed = observeProcessStartTime(pid);
  if (!observed) return undefined;
  // The command can legitimately change when a spawned interpreter execs its
  // target or becomes a zombie. The kernel start time remains stable for that
  // process and changes when the PID is reused.
  return processIdentityFromStartTime(pid, observed);
}
