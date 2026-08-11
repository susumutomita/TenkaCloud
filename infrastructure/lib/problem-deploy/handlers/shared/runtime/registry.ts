/**
 * [Issue #1268] Adapter registry / selector.
 *
 * Maps a normalized `ProblemRuntime` to the concrete adapter that knows how
 * to drive that provider/engine. `aws/cloudformation` is always executable;
 * `sakura/apprun`, `azure/bicep`, `gcp/infra-manager` (#1410-#1412)
 * are executable when the deploy handler wired their account-gated context
 * (per-team credential + provider client) — without it they fall through to
 * `RuntimeNotSupportedError` with a roadmap-aware message. Anything else throws
 * as a likely typo.
 *
 * The registry is intentionally not a public map (= no module-level
 * `register(adapter)` API) because:
 *   - A static if-chain keeps the supported set greppable / auditable.
 *   - Whether a non-AWS provider is executable is a per-deployment wiring
 *     question (`deps.<provider>` present?), not a static registration question.
 */

import {
  classifyRuntimeSupport,
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
} from "@tenkacloud/problem-runtime";
import type { ProblemRuntime, ProblemRuntimeAdapter } from "./adapter.js";
import { RuntimeNotSupportedError } from "./adapter.js";
import {
  type AwsCloudFormationAdapterContext,
  AwsCloudFormationRuntimeAdapter,
} from "./aws-cfn-adapter.js";
import {
  AZURE_ENGINE,
  AZURE_PROVIDER,
  type AzureBicepAdapterContext,
  AzureBicepRuntimeAdapter,
} from "./azure-bicep-adapter.js";
import {
  GCP_ENGINE,
  GCP_PROVIDER,
  type GcpInfraManagerAdapterContext,
  GcpInfraManagerRuntimeAdapter,
} from "./gcp-infra-manager-adapter.js";
import {
  SAKURA_ENGINE,
  SAKURA_PROVIDER,
  type SakuraAppRunAdapterContext,
  SakuraAppRunRuntimeAdapter,
} from "./sakura-apprun-adapter.js";

/**
 * Dependencies any adapter might need. The AWS subset is always present; provider
 * adapters whose I/O is account-gated (Sakura key + AppRun client, Azure/GCP credentials)
 * are **optional** — the deploy handler wires them only when that provider is
 * configured, so an un-provisioned provider stays `RuntimeNotSupportedError` (reserved)
 * rather than failing at the cloud call. The adapter code + tests exist regardless.
 */
export interface AdapterDependencies {
  readonly aws: AwsCloudFormationAdapterContext;
  /** [#1412] sakura/apprun — present only when the handler has the account-gated client + key. */
  readonly sakura?: SakuraAppRunAdapterContext;
  /** [#1410] azure/bicep — present only when the handler wired the WIF credential + ARM client. */
  readonly azure?: AzureBicepAdapterContext;
  /** [#1411] gcp/infra-manager — present only when the handler wired the WIF credential + IM client. */
  readonly gcp?: GcpInfraManagerAdapterContext;
}

export function selectAdapter(
  runtime: ProblemRuntime,
  deps: AdapterDependencies,
): ProblemRuntimeAdapter {
  if (runtime.provider === EXECUTABLE_PROVIDER && runtime.engine === EXECUTABLE_ENGINE) {
    return new AwsCloudFormationRuntimeAdapter(deps.aws);
  }
  // [#1412] sakura/apprun is executable only when the handler wired the
  // account-gated context (SSM key resolver + AppRun client). Until then it falls
  // through to the reserved-runtime error (no silent stub, no cloud mutation).
  if (runtime.provider === SAKURA_PROVIDER && runtime.engine === SAKURA_ENGINE && deps.sakura) {
    return new SakuraAppRunRuntimeAdapter(deps.sakura, runtime);
  }
  // [#1410-1411] azure/bicep + gcp/infra-manager are executable only when the handler
  // wired the account-gated WIF context (trust-bridge credential + provider client). Until then
  // they fall through to the reserved-runtime error (no silent stub, no cloud mutation).
  if (runtime.provider === AZURE_PROVIDER && runtime.engine === AZURE_ENGINE && deps.azure) {
    return new AzureBicepRuntimeAdapter(deps.azure, runtime);
  }
  if (runtime.provider === GCP_PROVIDER && runtime.engine === GCP_ENGINE && deps.gcp) {
    return new GcpInfraManagerRuntimeAdapter(deps.gcp, runtime);
  }
  // Recognized but unconfigured providers get a configuration-aware message, local container
  // problems get a "run make local" message, everything else is a likely
  // typo. All still throw — no adapter, no cloud mutation.
  const support = classifyRuntimeSupport(runtime);
  throw new RuntimeNotSupportedError(runtime, {
    reserved: support === "reserved",
    container: support === "container",
  });
}
