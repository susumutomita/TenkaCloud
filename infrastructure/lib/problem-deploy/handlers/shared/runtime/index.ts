/**
 * [Issue #1268] Runtime adapter package barrel.
 *
 * Public entrypoints used by the deploy handler and tests. Keep this re-export
 * surface minimal so future adapters slot in via `selectAdapter` only and do
 * not leak provider-specific types into the rest of the handler code.
 */

export {
  buildCompositeDeploymentPlan,
  COMPOSITE_PROVIDERS,
  type CompositeDeploymentPlan,
  type CompositeRuntimeDescriptor,
  classifyRuntimeSupport,
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  isCompositeRuntime,
  isExecutableRuntime,
  isReservedRuntime,
  normalizeRuntime,
  type ProblemRuntimeDescriptor,
  RESERVED_RUNTIMES,
  type ReservedProvider,
  type RuntimeMetadataInput,
  type RuntimeSupport,
} from "@tenkacloud/problem-runtime";
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
  AZURE_ENGINE,
  AZURE_PROVIDER,
  type AzureArmTemplateSource,
  type AzureArtifactLocation,
  type AzureBicepAdapterContext,
  AzureBicepRuntimeAdapter,
  type AzureCredential,
  type AzureDeploymentStackClient,
  type AzureDeploymentStackSpec,
  type AzureDeploymentStackState,
  mapAzureProvisioningState,
} from "./azure-bicep-adapter.js";
export {
  GCP_ENGINE,
  GCP_PROVIDER,
  type GcpCredential,
  type GcpDeploymentSpec,
  type GcpDeploymentState,
  type GcpInfraManagerAdapterContext,
  type GcpInfraManagerClient,
  GcpInfraManagerRuntimeAdapter,
  type MaterializeGcpBlueprintInput,
  mapGcpDeploymentState,
} from "./gcp-infra-manager-adapter.js";
export { type RuntimeItemFields, resolveItemRuntime } from "./item-runtime.js";
export { type AdapterDependencies, selectAdapter } from "./registry.js";
export {
  asCompositeDescriptor,
  makeProblemRuntimeDescriptorResolver,
  makeProblemRuntimeResolver,
  parseProblemRuntimeDescriptors,
  parseProblemRuntimes,
} from "./runtime-catalog-env.js";
export {
  mapSakuraStatus,
  SAKURA_ENGINE,
  SAKURA_PROVIDER,
  type SakuraApplicationState,
  type SakuraAppRunAdapterContext,
  type SakuraAppRunClient,
  SakuraAppRunRuntimeAdapter,
  type SakuraAppRunSpec,
  type SakuraCredential,
} from "./sakura-apprun-adapter.js";
