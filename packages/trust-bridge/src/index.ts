/**
 * @TenkaCloud/trust-bridge — Issue #795 public surface。
 *
 * 「クレデンシャルを越境させず、 署名された CloudActionIntent を越境させ、
 *  検証側で短命 provider-native authority に交換する」 protocol の基盤層。
 *
 * Phase 1 出荷範囲:
 *   - CloudActionIntent schema (zod)
 *   - canonical JSON serialization
 *   - JWS HS256 and ES256 sign / verify
 *   - TTL / notBefore 検証
 *   - nonce hook 抽象
 *   - audit record helper
 *
 * Phase 2 以降:
 *   - AwsAssumeRoleExchange (= 既存 ExternalId flow を本 abstraction に migrate)
 *   - Deploy API への internal integration
 *   - GCP / Azure adapter prototype
 *   - protocol 文書
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
  CloudActionEnforcementMode,
  CloudActionPolicy,
  CloudActionRiskContext,
  CloudActionVerdict,
  RequireApprovalRule,
} from "./cloud-action-policy.js";
export { evaluateCloudActionRisk } from "./cloud-action-policy.js";
export type {
  CfnDeployClient,
  CfnExecutionAction,
  CfnExecutionResult,
  CfnStackMutationInput,
  CloudFormationExecutorOptions,
} from "./cloudformation-executor.js";
export { CloudFormationExecutor, deriveStackName } from "./cloudformation-executor.js";
export type {
  AgentExecuted,
  AgentRejected,
  AgentRunInput,
  AgentRunOutcome,
  AuditWriter,
  CustomerExecutionAgentOptions,
} from "./customer-execution-agent.js";
export { CustomerExecutionAgent } from "./customer-execution-agent.js";
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
  DdbConditionalPutClient,
  DdbConditionalPutInput,
  DdbNonceStoreOptions,
} from "./ddb-nonce-store.js";
export { DdbNonceStore } from "./ddb-nonce-store.js";
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
export {
  base64urlDecode,
  base64urlEncode,
  signIntent,
  verifySignature,
} from "./jws.js";
export type { Es256SignOptions, Es256VerifyOptions } from "./jws-es256.js";
export {
  ALG_ES256,
  signIntentEs256,
  verifySignatureEs256,
} from "./jws-es256.js";
export type {
  BudgetPolicyEvaluatorOptions,
  CfnTemplateInspectorOptions,
  ForbiddenTemplatePattern,
} from "./local-policy.js";
export {
  combinePolicyEvaluators,
  createBudgetPolicyEvaluator,
  createCfnTemplateInspector,
  DEFAULT_FORBIDDEN_TEMPLATE_PATTERNS,
} from "./local-policy.js";
// Issue #2216: LocalStackCloudAdapter / MockCloudAdapter are test/PoC fixtures standing in for
// a real cloud adapter (aws/azure/gcp), not part of the public API surface. Non-test consumers
// import them directly from their module file instead of through this barrel.

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
