import { Worker } from "node:worker_threads";
import type { RelayRequest, RelayTarget } from "./container/relay-target";
import type { LocalNetworkPlan, LocalPublicEndpoint } from "./local-network";

interface WorkerQueue {
  active: number;
  readonly waiting: (() => void)[];
}
type WorkerMode = "verify" | "stop" | "quarantine" | "reset" | "publish";
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
  const routes = plan?.publicRoutes.length ?? 0;
  const runtimes = details.runtimes ?? [];
  const passes =
    (operation === "publish" ? (details.previous?.publicRoutes.length ?? 0) + 3 * routes : routes) +
    runtimes.reduce((total, runtime) => total + runtime.plan.publicRoutes.length, 0);
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
