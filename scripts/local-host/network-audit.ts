import { Worker } from "node:worker_threads";
import type { LocalNetworkPlan, LocalPublicEndpoint } from "./local-network";

interface WorkerQueue {
  active: number;
  readonly waiting: (() => void)[];
}
type WorkerMode = "verify" | "stop" | "quarantine" | "reset" | "publish";
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
export function publishNetwork(plan: LocalNetworkPlan, previous: LocalNetworkPlan): Promise<void> {
  return queuedOperation(auditQueue, plan, "publish", () =>
    runAudit(plan, "publish", { previous }),
  );
}
export async function networkEndpoints(
  plan: LocalNetworkPlan,
  service: string,
  port: number,
): Promise<readonly LocalPublicEndpoint[]> {
  await acquire(auditQueue);
  try {
    return await runWorker<readonly LocalPublicEndpoint[]>(plan, "endpoints", { service, port });
  } finally {
    release(auditQueue);
  }
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
  mode: WorkerMode,
  details: { previous?: LocalNetworkPlan } = {},
): Promise<void> {
  return runWorker<undefined>(plan, mode, details);
}
function runWorker<T>(
  plan: LocalNetworkPlan,
  mode: WorkerMode | "endpoints",
  details: { previous?: LocalNetworkPlan; service?: string; port?: number },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const entry = import.meta.url.endsWith(".ts")
      ? new URL("./network-audit-worker.ts", import.meta.url)
      : new URL("./network-audit-worker.mjs", import.meta.url);
    const worker = new Worker(entry, {
      workerData: { plan, mode, ...details },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate().then(() => (error ? reject(error) : resolve(value as T)), reject);
    };
    const timeout = setTimeout(
      () => finish(new Error("Competition network audit timed out.")),
      20_000,
    );
    timeout.unref();
    worker.once("message", (result: { ok?: boolean; error?: string; value?: T }) =>
      finish(
        result.ok === true
          ? undefined
          : new Error(result.error ?? "Competition network audit failed."),
        result.value,
      ),
    );
    worker.once("error", finish);
    worker.once("exit", () => {
      if (!settled) finish(new Error("Competition network audit exited without verification."));
    });
  });
}
