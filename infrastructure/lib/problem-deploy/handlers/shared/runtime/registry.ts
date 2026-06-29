/**
 * [ADR-023 / Issue #1268] Adapter registry / selector.
 *
 * Maps a normalized `ProblemRuntime` to the concrete adapter that knows how
 * to drive that provider/engine. Phase 1: only `aws/cloudformation` is
 * registered. Any other combination throws `RuntimeNotSupportedError`.
 *
 * The registry is intentionally not a public map (= no module-level
 * `register(adapter)` API) because:
 *   - Phase 1 has exactly one adapter; a Map would be over-engineering.
 *   - Adding a second adapter is its own PR with its own ADR amendment, at
 *     which point we revisit the data structure.
 *   - A static switch makes the supported set greppable / auditable.
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
 * adapters whose I/O is account-gated (Sakura key + AppRun client, future Azure/GCP)
 * are **optional** — the deploy handler wires them only when that provider is
 * configured, so an un-provisioned provider stays `RuntimeNotSupportedError` (reserved)
 * rather than failing at the cloud call. The adapter code + tests exist regardless.
 */
export interface AdapterDependencies {
  readonly aws: AwsCloudFormationAdapterContext;
  /** [ADR-026 / #1412] sakura/apprun — present only when the handler has the account-gated client + key. */
  readonly sakura?: SakuraAppRunAdapterContext;
  /** [ADR-027 / #1410] azure/bicep — present only when the handler wired the WIF credential + ARM client. */
  readonly azure?: AzureBicepAdapterContext;
  /** [ADR-027 / #1411] gcp/infra-manager — present only when the handler wired the WIF credential + IM client. */
  readonly gcp?: GcpInfraManagerAdapterContext;
}

export function selectAdapter(
  runtime: ProblemRuntime,
  deps: AdapterDependencies,
): ProblemRuntimeAdapter {
  if (runtime.provider === EXECUTABLE_PROVIDER && runtime.engine === EXECUTABLE_ENGINE) {
    return new AwsCloudFormationRuntimeAdapter(deps.aws);
  }
  // [ADR-026 / #1412] sakura/apprun is executable only when the handler wired the
  // account-gated context (SSM key resolver + AppRun client). Until then it falls
  // through to the reserved-runtime error (no silent stub, no cloud mutation).
  if (runtime.provider === SAKURA_PROVIDER && runtime.engine === SAKURA_ENGINE && deps.sakura) {
    return new SakuraAppRunRuntimeAdapter(deps.sakura, runtime);
  }
  // [ADR-027 / #1410-1411] azure/bicep + gcp/infra-manager are executable only when the handler
  // wired the account-gated WIF context (trust-bridge credential + provider client). Until then
  // they fall through to the reserved-runtime error (no silent stub, no cloud mutation).
  if (runtime.provider === AZURE_PROVIDER && runtime.engine === AZURE_ENGINE && deps.azure) {
    return new AzureBicepRuntimeAdapter(deps.azure, runtime);
  }
  if (runtime.provider === GCP_PROVIDER && runtime.engine === GCP_ENGINE && deps.gcp) {
    return new GcpInfraManagerRuntimeAdapter(deps.gcp, runtime);
  }
  // Planned providers (ADR-026/027) get a roadmap-aware message, local container
  // problems (ADR-023) get a "run make local" message, everything else is a likely
  // typo. All still throw — no adapter, no cloud mutation.
  const support = classifyRuntimeSupport(runtime);
  throw new RuntimeNotSupportedError(runtime, {
    reserved: support === "reserved",
    container: support === "container",
  });
}
