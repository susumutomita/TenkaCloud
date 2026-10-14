import { parentPort, workerData } from "node:worker_threads";
import { LinuxNetworkGuard } from "./linux-network-guard";
import type { LocalNetworkPlan } from "./local-network";

if (!parentPort) throw new Error("Network audits require an internal worker.");
try {
  const guard = new LinuxNetworkGuard();
  if (workerData.mode === "stop") guard.stopOwnedSync(workerData.plan as LocalNetworkPlan);
  else if (workerData.mode === "quarantine") guard.quarantine(workerData.plan as LocalNetworkPlan);
  else if (workerData.mode === "reset") guard.resetStopped(workerData.plan as LocalNetworkPlan);
  else if (workerData.mode === "verify") guard.verifyNetworks(workerData.plan as LocalNetworkPlan);
  else throw new Error("Invalid internal network worker operation.");
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : "Network audit failed.",
  });
} finally {
  parentPort.close();
}
