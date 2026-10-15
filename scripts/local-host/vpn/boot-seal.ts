import { parseArgs } from "node:util";
import { loadVpnPeerPlan } from "./config";
import { NativeVpnIngress } from "./native-ingress";

/** Operator-installed boot prerequisite; never invoked by a test or import. */
export function bootVpnSeal(args: string[]): void {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: { config: { type: "string" } },
  });
  if (!values.config)
    throw new Error("Supply the root-owned public peer registration with --config.");
  new NativeVpnIngress(loadVpnPeerPlan(values.config)).seal();
}
if (import.meta.main) bootVpnSeal(process.argv.slice(2));
