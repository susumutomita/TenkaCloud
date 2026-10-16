import { readlinkSync, statSync } from "node:fs";
import { isMainThread, workerData } from "node:worker_threads";

/** Workers release this native-mutation lock themselves, before notifying the controller.
 * Synchronous emergency VPN seals can therefore wait without waiting for its event loop.
 */
interface HookContext {
  buffer: SharedArrayBuffer;
  owner: number;
  thread: SharedArrayBuffer;
}
const context: HookContext =
  !isMainThread && workerData?.hookLock
    ? workerData.hookLock
    : { buffer: new SharedArrayBuffer(4), owner: 1, thread: new SharedArrayBuffer(4) };
const state = new Int32Array(context.buffer);
const workers = new Map<number, HookContext>();
if (!isMainThread && workerData?.hookLock && process.platform === "linux") {
  // Linux native hooks run on this OS thread. Its proc task disappears even when the
  // controller cannot process the worker's exit callback. A missing proc mount fails closed.
  const task = readlinkSync("/proc/thread-self").split("/").at(-1);
  if (!task || !/^\d+$/u.test(task)) throw new Error("Cannot identify the native network worker.");
  Atomics.store(new Int32Array(context.thread), 0, Number(task));
}
let nextOwner = 2;
let depth = 0;

export function networkHookWorkerContext(): typeof context {
  const worker = { buffer: context.buffer, owner: nextOwner++, thread: new SharedArrayBuffer(4) };
  workers.set(worker.owner, worker);
  return worker;
}
/** Only call after this worker has terminated; never release another worker's ownership. */
export function releaseNetworkHookWorker(worker: typeof context): void {
  if (Atomics.compareExchange(state, 0, worker.owner, 0) === worker.owner) Atomics.notify(state, 0);
  workers.delete(worker.owner);
}
export function withNetworkHookLock<T>(run: () => T, timeoutMs = 120_000): T {
  if (depth) return run();
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const owner = Atomics.compareExchange(state, 0, 0, context.owner);
    if (owner === 0) break;
    const worker = workers.get(owner);
    const thread = worker ? Atomics.load(new Int32Array(worker.thread), 0) : 0;
    if (worker && thread > 0 && exitedThread(thread)) {
      releaseNetworkHookWorker(worker);
      continue;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Competition network hook ordering timed out.");
    Atomics.wait(state, 0, owner, Math.min(remaining, 10));
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

function exitedThread(thread: number): boolean {
  try {
    statSync(`/proc/self/task/${thread}`);
    return false;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
    // A missing proc mount or an unreadable task inventory is not proof of termination.
    if (!statSync("/proc/self/task").isDirectory())
      throw new Error("Cannot inspect native network worker threads.");
    return true;
  }
}
