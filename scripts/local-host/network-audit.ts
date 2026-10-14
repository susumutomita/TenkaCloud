import { Worker } from "node:worker_threads";
import type { LocalNetworkPlan } from "./local-network";

let active = 0;
const waiting: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (active < 2) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}
/** Read-only native subprocess audits run off the controller event loop, at most two at a time. */
export async function auditNetwork(plan: LocalNetworkPlan): Promise<void> {
  await acquire();
  try {
    await runAudit(plan, "verify");
  } finally {
    release();
  }
}
export async function stopNetwork(plan: LocalNetworkPlan): Promise<void> {
  await acquire();
  try {
    await runAudit(plan, "stop");
  } finally {
    release();
  }
}
export function emergencyNetwork(
  plan: LocalNetworkPlan,
  mode: "quarantine" | "reset",
): Promise<void> {
  // Emergency drops must never queue behind wedged Docker inspection workers.
  return runAudit(plan, mode);
}
function runAudit(
  plan: LocalNetworkPlan,
  mode: "verify" | "stop" | "quarantine" | "reset",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const entry = import.meta.url.endsWith(".ts")
      ? new URL("./network-audit-worker.ts", import.meta.url)
      : new URL("./network-audit-worker.mjs", import.meta.url);
    const worker = new Worker(entry, {
      workerData: { plan, mode },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate().then(() => (error ? reject(error) : resolve()), reject);
    };
    const timeout = setTimeout(
      () => finish(new Error("Competition network audit timed out.")),
      20_000,
    );
    timeout.unref();
    worker.once("message", (result: { ok?: boolean; error?: string }) =>
      finish(
        result.ok === true
          ? undefined
          : new Error(result.error ?? "Competition network audit failed."),
      ),
    );
    worker.once("error", finish);
    worker.once("exit", () => {
      if (!settled) finish(new Error("Competition network audit exited without verification."));
    });
  });
}
