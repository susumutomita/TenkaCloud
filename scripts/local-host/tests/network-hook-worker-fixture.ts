import { parentPort, workerData } from "node:worker_threads";
import { LinuxNetworkGuard } from "../linux-network-guard";
import { localNetworkPlan } from "../local-network";
import { withNetworkHookLock } from "../network-hook-lock";

// Synthetic critical sections only: never invokes a native command.
if (workerData.crash) {
  // Model an abruptly terminated native worker that cannot execute its finally block.
  Atomics.store(new Int32Array(workerData.hookLock.buffer), 0, workerData.hookLock.owner);
  parentPort?.postMessage("held");
} else if (workerData.inspect) {
  const guard = new LinuxNetworkGuard();
  Reflect.set(guard, "preflight", () => {
    parentPort?.postMessage("held");
    const trace = new Int32Array(workerData.trace);
    Atomics.wait(trace, 0, 0, 2000);
    throw new Error("Synthetic inspection complete");
  });
  try {
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic plan; preflight never invokes native I/O
    guard.install(localNetworkPlan("tch-inspect-lock", { default: "10.249.0.0/28" }));
  } catch {
    /* Synthetic preflight stops before any native command. */
  }
} else {
  withNetworkHookLock(() => {
    parentPort?.postMessage("held");
    const trace = new Int32Array(workerData.trace);
    Atomics.wait(trace, 0, 0, 50);
    Atomics.store(trace, 0, 1);
  });
}
parentPort?.close();
