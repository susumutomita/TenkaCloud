/**
 * @TenkaCloud/trust-bridge — Issue #795 / ADR-017 Phase 1 public surface。
 *
 * 「クレデンシャルを越境させず、 署名された CloudActionIntent を越境させ、
 *  検証側で短命 provider-native authority に交換する」 protocol の基盤層。
 *
 * Phase 1 出荷範囲:
 *   - CloudActionIntent schema (zod)
 *   - canonical JSON serialization
 *   - JWS HS256 sign / verify
 *   - TTL / notBefore 検証
 *   - nonce hook 抽象
 *   - audit record helper
 *
 * Phase 2 以降:
 *   - AwsAssumeRoleExchange (= 既存 ExternalId flow を本 abstraction に migrate)
 *   - Deploy API への internal integration
 *   - GCP / Azure adapter prototype
 *   - protocol 文書 (= docs/architecture/cloud-action-intent.html)
 */

export type { AuditInput, CloudActionAuditRecord } from "./audit.js";
export { buildAuditRecord } from "./audit.js";
export type {
  AssumeRoleInput,
  AssumeRoleOutput,
  AwsAssumeRoleExchangeOptions,
  AwsCredential,
  AwsExchangeContext,
  StsAssumeRoleClient,
} from "./aws-assume-role.js";
export { AwsAssumeRoleExchange } from "./aws-assume-role.js";
export type {
  AzureAdapterOptions,
  AzureCredential,
  AzureExchangeContext,
  AzureTokenEndpointClient,
  AzureTokenExchangeInput,
  AzureTokenExchangeOutput,
} from "./azure-federated-credential.js";
export { AzureFederatedCredentialExchange } from "./azure-federated-credential.js";
export type {
  ArtifactInspection,
  ArtifactInspector,
  ClaimInput,
  CustomerExecutionAuthorized,
  CustomerExecutionOutcome,
  CustomerExecutionPlaneOptions,
  CustomerExecutionPolicy,
  CustomerExecutionRejected,
  CustomerExecutionRejectionReason,
  CustomerExecutionStage,
  PolicyDecision,
  PolicyEvaluator,
} from "./customer-execution-plane.js";
export { CustomerExecutionPlane, computeArtifactDigest } from "./customer-execution-plane.js";

export type {
  GcpAdapterOptions,
  GcpCredential,
  GcpExchangeContext,
  GcpStsClient,
  GcpStsExchangeInput,
  GcpStsExchangeOutput,
  GenerateServiceAccountTokenInput,
  GenerateServiceAccountTokenOutput,
} from "./gcp-workload-identity.js";
export { GcpWorkloadIdentityFederationExchange } from "./gcp-workload-identity.js";
export type {
  JwsHeader,
  SignOptions,
  VerifyFailureReason,
  VerifyOptions,
  VerifyOutcome,
} from "./jws.js";
export { signIntent, verifySignature } from "./jws.js";
export type {
  LocalStackCloudAdapterOptions,
  LocalStackCredential,
  LocalStackExchangeContext,
} from "./localstack-cloud-adapter.js";
export { LocalStackCloudAdapter } from "./localstack-cloud-adapter.js";
export type {
  MockCloudAdapterOptions,
  MockCloudCredential,
  MockCloudExchangeContext,
  MockDeploymentSignal,
  MockDeploymentSignalStatus,
} from "./mock-cloud-adapter.js";
export { MockCloudAdapter } from "./mock-cloud-adapter.js";

export type {
  ExchangeContext,
  ExchangeFailureReason,
  ProviderCredential,
  ProviderId,
  ProviderTokenExchange,
} from "./provider.js";
export { ExchangeError } from "./provider.js";
export type { CloudActionIntent, VerifiedCloudActionIntent } from "./schema.js";
export {
  brandVerified,
  CloudActionIntentSchema,
  canonicalize,
  INTENT_VERSION,
  parseCloudActionIntent,
} from "./schema.js";
export type {
  IntentVerifyError,
  IntentVerifyFailureReason,
  IntentVerifyOk,
  IntentVerifyOptions,
  IntentVerifyOutcome,
  NonceStore,
} from "./verify.js";
export { verifyIntent } from "./verify.js";
