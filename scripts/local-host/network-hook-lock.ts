import { isMainThread, workerData } from "node:worker_threads";

/** Workers release this native-mutation lock themselves, before notifying the controller.
 * Synchronous emergency VPN seals can therefore wait without waiting for its event loop.
 */
const context: { buffer: SharedArrayBuffer; owner: number } =
  !isMainThread && workerData?.hookLock
    ? workerData.hookLock
    : { buffer: new SharedArrayBuffer(4), owner: 1 };
const state = new Int32Array(context.buffer);
let nextOwner = 2;
let depth = 0;

export function networkHookWorkerContext(): typeof context {
  return { buffer: context.buffer, owner: nextOwner++ };
}
/** Only call after this worker has terminated; never release another worker's ownership. */
export function releaseNetworkHookWorker(worker: typeof context): void {
  if (Atomics.compareExchange(state, 0, worker.owner, 0) === worker.owner) Atomics.notify(state, 0);
}
export function withNetworkHookLock<T>(run: () => T, timeoutMs = 120_000): T {
  if (depth) return run();
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const owner = Atomics.compareExchange(state, 0, 0, context.owner);
    if (owner === 0) break;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Competition network hook ordering timed out.");
    Atomics.wait(state, 0, owner, remaining);
  }
  depth++;
  try {
    return run();
  } finally {
    depth--;
    Atomics.store(state, 0, 0);
    Atomics.notify(state, 0);
  }
}
