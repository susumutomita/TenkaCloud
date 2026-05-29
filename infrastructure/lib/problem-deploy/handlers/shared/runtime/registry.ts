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

import type { ProblemRuntime, ProblemRuntimeAdapter } from "./adapter.js";
import { RuntimeNotSupportedError } from "./adapter.js";
import {
  type AwsCloudFormationAdapterContext,
  AwsCloudFormationRuntimeAdapter,
} from "./aws-cfn-adapter.js";
import { classifyRuntimeSupport, EXECUTABLE_ENGINE, EXECUTABLE_PROVIDER } from "./normalize.js";

/**
 * Dependencies any adapter might need. Phase 1 only uses the AWS subset; the
 * shape is open so future adapters (Azure ARM client, kubectl client, etc.)
 * can be added without changing this signature.
 */
export interface AdapterDependencies {
  readonly aws: AwsCloudFormationAdapterContext;
}

export function selectAdapter(
  runtime: ProblemRuntime,
  deps: AdapterDependencies,
): ProblemRuntimeAdapter {
  if (runtime.provider === EXECUTABLE_PROVIDER && runtime.engine === EXECUTABLE_ENGINE) {
    return new AwsCloudFormationRuntimeAdapter(deps.aws);
  }
  // Planned providers (ADR-026/027) get a roadmap-aware message; everything else
  // is treated as a likely typo. Both still throw — no adapter, no cloud mutation.
  throw new RuntimeNotSupportedError(runtime, {
    reserved: classifyRuntimeSupport(runtime) === "reserved",
  });
}
