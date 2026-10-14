import { Worker } from "node:worker_threads";
import type { LocalNetworkPlan } from "./local-network";

interface WorkerQueue {
  active: number;
  readonly waiting: (() => void)[];
}
type WorkerMode = "verify" | "stop" | "quarantine" | "reset";
type WorkerRunner = (plan: LocalNetworkPlan, mode: WorkerMode) => Promise<void>;
const auditQueue: WorkerQueue = { active: 0, waiting: [] };
const emergencyQueue: WorkerQueue = { active: 0, waiting: [] };
async function acquire(queue: WorkerQueue): Promise<void> {
  if (queue.active < 2) {
    queue.active++;
    return;
  }
  await new Promise<void>((resolve) => queue.waiting.push(resolve));
}
function release(queue: WorkerQueue): void {
  const next = queue.waiting.shift();
  if (next) next();
  else queue.active--;
}
async function queuedOperation(
  queue: WorkerQueue,
  plan: LocalNetworkPlan,
  mode: WorkerMode,
  run: WorkerRunner,
): Promise<void> {
  await acquire(queue);
  try {
    await run(plan, mode);
  } finally {
    release(queue);
  }
}
/** Native subprocess audits and stops run off the controller loop, at most two at a time. */
export function auditNetwork(plan: LocalNetworkPlan, run: WorkerRunner = runAudit): Promise<void> {
  return queuedOperation(auditQueue, plan, "verify", run);
}
export function stopNetwork(plan: LocalNetworkPlan, run: WorkerRunner = runAudit): Promise<void> {
  return queuedOperation(auditQueue, plan, "stop", run);
}
export function emergencyNetwork(
  plan: LocalNetworkPlan,
  mode: "quarantine" | "reset",
  run: WorkerRunner = runAudit,
): Promise<void> {
  // Only firewall-only drops use the emergency queue; reset inspects Docker and must not block drops.
  return queuedOperation(mode === "quarantine" ? emergencyQueue : auditQueue, plan, mode, run);
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
