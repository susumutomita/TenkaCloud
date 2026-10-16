import { parentPort, workerData } from "node:worker_threads";
import { resolveRelayTarget } from "./container/relay-target";
import { LinuxNetworkGuard } from "./linux-network-guard";
import type { LocalNetworkPlan } from "./local-network";
import { NativeVpnBackend } from "./vpn/native-backend";
import { vpnPeerPlan } from "./vpn/peer-plan";

if (!parentPort) throw new Error("Network audits require an internal worker.");
try {
  const guard = new LinuxNetworkGuard();
  let value: unknown;
  if (workerData.mode === "vpn-prepare") {
    const registration = { ...workerData.config };
    delete registration.generation;
    const config = vpnPeerPlan(registration);
    value = new NativeVpnBackend(config).prepare(workerData.runtimes);
  } else if (workerData.mode === "relay-target")
    value = resolveRelayTarget(workerData.request, workerData.expected);
  else if (workerData.mode === "stop") guard.stopOwnedSync(workerData.plan as LocalNetworkPlan);
  else if (workerData.mode === "quarantine") guard.quarantine(workerData.plan as LocalNetworkPlan);
  else if (workerData.mode === "reset") guard.resetStopped(workerData.plan as LocalNetworkPlan);
  else if (workerData.mode === "install") guard.install(workerData.plan as LocalNetworkPlan);
  else if (workerData.mode === "verify") guard.verifyNetworks(workerData.plan as LocalNetworkPlan);
  else if (workerData.mode === "publish") {
    guard.update(workerData.plan, workerData.previous);
    guard.routePublications(workerData.plan);
    guard.verifyNetworks(workerData.plan);
  } else if (workerData.mode === "endpoints") {
    guard.verifyNetworks(workerData.plan);
    value = guard.endpoints(workerData.plan, workerData.service, workerData.port);
  } else throw new Error("Invalid internal network worker operation.");
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : "Network audit failed.",
  });
} finally {
  parentPort.close();
}
