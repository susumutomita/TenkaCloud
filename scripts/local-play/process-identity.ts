import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export function processIdentityFromStartTime(pid: number, startTime: string): string {
  return createHash("sha256").update(`${pid}:${startTime.trim()}`).digest("hex");
}

export function parseProcessObservation(value: string): string | undefined {
  const match = /^(?<state>\S+)\s+(?<startTime>.+)$/.exec(value.trim());
  if (!match?.groups || match.groups.state.startsWith("Z")) return undefined;
  return match.groups.startTime.trim();
}

export function observeProcessStartTime(pid: number): string | undefined {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat=", "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 ? parseProcessObservation(result.stdout) : undefined;
}

/** Hash the OS-observed process start time and PID to detect PID reuse. */
export function observeProcessIdentity(pid: number): string | undefined {
  const observed = observeProcessStartTime(pid);
  if (!observed) return undefined;
  // The command can legitimately change when a spawned interpreter execs its
  // target. The kernel start time remains stable and changes when the PID is
  // reused. Zombies are filtered above because they have already exited.
  return processIdentityFromStartTime(pid, observed);
}
