import { Worker } from "node:worker_threads";
import type { RelayRequest, RelayTarget } from "./container/relay-target";
import type { LocalNetworkPlan, LocalPublicEndpoint } from "./local-network";
import { networkHookWorkerContext, releaseNetworkHookWorker } from "./network-hook-lock";

interface WorkerQueue {
  active: number;
  readonly waiting: (() => void)[];
}
type WorkerMode = "install" | "verify" | "stop" | "quarantine" | "reset" | "publish";
type WorkerOperation = WorkerMode | "endpoints" | "relay-target" | "vpn-prepare";
type WorkerRunner = (plan: LocalNetworkPlan, mode: WorkerMode) => Promise<void>;
const BASE_DEADLINE_MS = 20_000;
// Each admitted route costs every verification pass two firewall checks and three Docker inspections.
const ROUTE_PASS_MS = 100;
// VPN preparation fully verifies each admitted runtime, then installs its reply routes.
const RUNTIME_PASS_MS = 5_000;
// Bounds how long one wedged daemon call chain can hold one of the two audit slots.
const MAX_DEADLINE_MS = 120_000;
/** Publication verifies the previous plan, then rewrites, routes and re-verifies the new one. */
export function workerDeadline(
  operation: WorkerOperation,
  plan?: LocalNetworkPlan,
  details: {
    readonly previous?: LocalNetworkPlan;
    readonly runtimes?: readonly { readonly plan: LocalNetworkPlan }[];
  } = {},
): number {
  const count = (value?: LocalNetworkPlan) =>
    (value?.publicRoutes.length ?? 0) +
    (value?.egressRoutes.length ?? 0) +
    (value?.egressSegments.length ?? 0);
  const routes = count(plan);
  const runtimes = details.runtimes ?? [];
  const passes =
    (operation === "publish" ? count(details.previous) + 3 * routes : routes) +
    runtimes.reduce((total, runtime) => total + count(runtime.plan), 0);
  return Math.min(
    MAX_DEADLINE_MS,
    BASE_DEADLINE_MS + runtimes.length * RUNTIME_PASS_MS + passes * ROUTE_PASS_MS,
  );
}
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
/**
 * An install inserts hooks at positions read from earlier snapshots, so any other hook change in
 * between would shift them. Quarantines insert only at the head and removals delete by rule, so
 * they may overlap each other, never an install. Waiters start in arrival order, so neither side
 * starves.
 */
type HookWork = "install" | "quarantine" | "remove";
const hookOrder = {
  installing: false,
  sharing: 0,
  waiting: [] as { work: HookWork; start: () => void }[],
};
function hookWorkFits(work: HookWork): boolean {
  return !hookOrder.installing && (work !== "install" || hookOrder.sharing === 0);
}
function enterHookWork(work: HookWork): void {
  if (work === "install") hookOrder.installing = true;
  else hookOrder.sharing++;
}
function leaveHookWork(work: HookWork): void {
  if (work === "install") hookOrder.installing = false;
  else hookOrder.sharing--;
  let next = hookOrder.waiting[0];
  while (next && hookWorkFits(next.work)) {
    hookOrder.waiting.shift();
    enterHookWork(next.work);
    next.start();
    next = hookOrder.waiting[0];
  }
}
async function inHookOrder(work: HookWork, run: () => Promise<void>): Promise<void> {
  if (hookOrder.waiting.length || !hookWorkFits(work))
    await new Promise<void>((start) => hookOrder.waiting.push({ work, start }));
  else enterHookWork(work);
  try {
    await run();
  } finally {
    leaveHookWork(work);
  }
}
function ordered(work: HookWork, run: WorkerRunner): WorkerRunner {
  return (plan, mode) => inHookOrder(work, () => run(plan, mode));
}
/** Removal still runs on the controller thread, but never while an install computes positions. */
export function removeNetwork(
  plan: LocalNetworkPlan,
  remove: (plan: LocalNetworkPlan) => void,
): Promise<void> {
  return inHookOrder("remove", async () => remove(plan));
}
/** Native subprocess audits and stops run off the controller loop, at most two at a time. */
export function auditNetwork(plan: LocalNetworkPlan, run: WorkerRunner = runAudit): Promise<void> {
  return queuedOperation(auditQueue, plan, "verify", run);
}
export function stopNetwork(plan: LocalNetworkPlan, run: WorkerRunner = runAudit): Promise<void> {
  return queuedOperation(auditQueue, plan, "stop", run);
}
export function installNetwork(
  plan: LocalNetworkPlan,
  run: WorkerRunner = runAudit,
): Promise<void> {
  return queuedOperation(auditQueue, plan, "install", ordered("install", run));
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
export async function relayTarget(
  request: RelayRequest,
  expected?: RelayTarget,
): Promise<RelayTarget> {
  await acquire(auditQueue);
  try {
    return await runWorker<RelayTarget>(request.plan, "relay-target", { request, expected });
  } finally {
    release(auditQueue);
  }
}
export async function stageVpnIngress(
  config: import("./vpn/peer-plan").VpnPeerPlan,
  runtimes: readonly import("./vpn/forward-policy").VpnRuntimeAdmission[],
): Promise<import("./vpn/peer-admission").VpnPeerProof> {
  await acquire(auditQueue);
  try {
    return await runWorker<import("./vpn/peer-admission").VpnPeerProof>(undefined, "vpn-prepare", {
      config,
      runtimes,
    });
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
  if (mode === "quarantine")
    return queuedOperation(emergencyQueue, plan, mode, ordered("quarantine", run));
  return queuedOperation(auditQueue, plan, mode, run);
}
function runAudit(
  plan: LocalNetworkPlan,
  mode: WorkerMode,
  details: { previous?: LocalNetworkPlan } = {},
): Promise<void> {
  return runWorker<undefined>(plan, mode, details);
}
function runWorker<T>(
  plan: LocalNetworkPlan | undefined,
  mode: WorkerOperation,
  details: {
    config?: import("./vpn/peer-plan").VpnPeerPlan;
    runtimes?: readonly import("./vpn/forward-policy").VpnRuntimeAdmission[];
    previous?: LocalNetworkPlan;
    service?: string;
    port?: number;
    request?: RelayRequest;
    expected?: RelayTarget;
  },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const entry = import.meta.url.endsWith(".ts")
      ? new URL("./network-audit-worker.ts", import.meta.url)
      : new URL("./network-audit-worker.mjs", import.meta.url);
    const hookLock = networkHookWorkerContext();
    const worker = new Worker(entry, {
      workerData: { plan, mode, ...details, hookLock },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate().then(() => {
        releaseNetworkHookWorker(hookLock);
        if (error) reject(error);
        else resolve(value as T);
      }, reject);
    };
    const timeout = setTimeout(
      () => finish(new Error("Competition network audit timed out.")),
      workerDeadline(mode, plan, details),
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
