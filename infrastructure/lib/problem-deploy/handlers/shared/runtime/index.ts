/**
 * [ADR-023 / Issue #1268] Runtime adapter package barrel.
 *
 * Public entrypoints used by the deploy handler and tests. Keep this re-export
 * surface minimal so future adapters slot in via `selectAdapter` only and do
 * not leak provider-specific types into the rest of the handler code.
 */

export type {
  ProblemRuntime,
  ProblemRuntimeAdapter,
  RuntimeCollectOutputsInput,
  RuntimeDeployInput,
  RuntimeDeployResult,
  RuntimeDestroyInput,
  RuntimeDestroyResult,
  RuntimeOutputs,
  RuntimeStatus,
  RuntimeStatusInput,
} from "./adapter.js";
export { RuntimeNotSupportedError } from "./adapter.js";
export {
  AdapterMethodNotWiredError,
  type AwsCloudFormationAdapterContext,
  AwsCloudFormationRuntimeAdapter,
} from "./aws-cfn-adapter.js";
export {
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  isExecutableRuntime,
  normalizeRuntime,
  type RuntimeMetadataInput,
} from "./normalize.js";
export { type AdapterDependencies, selectAdapter } from "./registry.js";
