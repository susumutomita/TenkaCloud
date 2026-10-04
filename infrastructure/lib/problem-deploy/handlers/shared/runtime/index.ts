/**
 * [Issue #1268] Runtime adapter package barrel.
 *
 * Public entrypoints used by the deploy handler and tests. Keep this re-export
 * surface minimal so future adapters slot in via `selectAdapter` only and do
 * not leak provider-specific types into the rest of the handler code.
 */

export {
  buildCompositeDeploymentPlan,
  type CompositeDeploymentPlan,
  type CompositeRuntimeDescriptor,
  classifyRuntimeSupport,
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  isExecutableRuntime,
  isReservedRuntime,
  normalizeRuntime,
  type ProblemRuntimeDescriptor,
  RESERVED_RUNTIMES,
  type ReservedProvider,
} from "@tenkacloud/problem-runtime";
export type {
  ProblemRuntime,
  RuntimeStatus,
} from "./adapter.js";
export { RuntimeNotSupportedError } from "./adapter.js";
export {
  AdapterMethodNotWiredError,
  AwsCloudFormationRuntimeAdapter,
} from "./aws-cfn-adapter.js";
export {
  AZURE_ENGINE,
  AZURE_PROVIDER,
  type AzureArtifactLocation,
  type AzureBicepAdapterContext,
  AzureBicepRuntimeAdapter,
  type AzureDeploymentStackClient,
  mapAzureProvisioningState,
} from "./azure-bicep-adapter.js";
export {
  GCP_ENGINE,
  GCP_PROVIDER,
  type GcpInfraManagerAdapterContext,
  type GcpInfraManagerClient,
  GcpInfraManagerRuntimeAdapter,
  mapGcpDeploymentState,
} from "./gcp-infra-manager-adapter.js";
export { resolveItemRuntime } from "./item-runtime.js";
export { type AdapterDependencies, selectAdapter } from "./registry.js";
export {
  asCompositeDescriptor,
  makeProblemRuntimeDescriptorResolver,
  makeProblemRuntimeResolver,
} from "./runtime-catalog-env.js";
export {
  mapSakuraStatus,
  SAKURA_ENGINE,
  SAKURA_PROVIDER,
  type SakuraAppRunAdapterContext,
  type SakuraAppRunClient,
  SakuraAppRunRuntimeAdapter,
} from "./sakura-apprun-adapter.js";
