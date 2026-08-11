import { createHash, timingSafeEqual } from "node:crypto";
import type { CloudActionIntent, VerifiedCloudActionIntent } from "./schema.js";
import {
  type IntentVerifyFailureReason,
  type IntentVerifyOptions,
  verifyIntent,
} from "./verify.js";

/**
 * Issue #1727: Customer Execution Plane validation core.
 *
 * In enterprise customer-execution mode the hosted TenkaCloud control plane
 * sends a signed `CloudActionIntent`, but provider-native authority never leaves
 * the customer trust boundary. This module is the gate a customer-controlled
 * execution component runs *before* it acquires any local authority.
 *
 * It enforces five customer-local properties in order and fails closed:
 *   1. intent authenticity  — did TenkaCloud sign this exact request? (`verifyIntent`)
 *   2. intent authorization — does THIS customer allow this action here? (local policy)
 *   3. artifact integrity   — are these the approved bytes? (signature-covered digest)
 *   4. artifact safety      — is the approved template acceptable locally? (inspector)
 *   5. execution authority  — exercised by the caller's *local* adapter, never here.
 *
 * A valid TenkaCloud signature alone is necessary but NOT sufficient: stage 2+
 * are evaluated against customer-local configuration the control plane cannot
 * influence, so a hosted control-plane compromise cannot deploy an arbitrary
 * artifact into a customer account.
 */

/**
 * Fail-closed `PolicyEvaluator`. The Customer Execution Plane is its first consumer. Policy authorship is
 * the library's responsibility to *call*, not to *implement* — callers plug in
 * an inline allowlist, OPA, Cedar, a tenant policy document, etc.
 */
export interface PolicyDecision {
  readonly decision: "allow" | "deny" | "needs_approval";
  readonly reason?: string;
  readonly allowedScopes?: readonly string[];
  readonly maxTtlSeconds?: number;
  readonly policyVersion?: string;
}

export interface PolicyEvaluator {
  evaluate(intent: VerifiedCloudActionIntent): Promise<PolicyDecision>;
}

/** Artifact-safety verdict (distinct from the digest binding of stage 3). */
export interface ArtifactInspection {
  readonly decision: "allow" | "deny";
  readonly reason?: string;
}

/**
 * Inspects the approved bytes (e.g. CloudFormation template risk analysis).
 * Runs only after the digest binding proves the bytes are the signed ones, so
 * the inspector always sees exactly what would be deployed.
 */
export interface ArtifactInspector {
  inspect(intent: VerifiedCloudActionIntent, bytes: Uint8Array): Promise<ArtifactInspection>;
}

type ActionType = CloudActionIntent["action"]["type"];

/**
 * Customer-local policy. Every field is configured inside the customer trust
 * boundary; none of it is signed by or visible to the hosted control plane.
 */
export interface CustomerExecutionPolicy {
  /** This execution plane's identity. The intent's `audience` must equal it exactly. */
  readonly audience: string;
  /** Deployment is confined to these provider accounts (= dedicated challenge/sandbox accounts). */
  readonly allowedProviderAccountRefs: readonly string[];
  /** Optional region allowlist. `undefined` = any region; `[]` = none. */
  readonly allowedRegions?: readonly string[];
  /** Locally approved problem ids. The intent's `source.problemId` must be present. */
  readonly approvedProblemIds: readonly string[];
  /** Permitted action types. Defaults to every intent action type. */
  readonly allowedActionTypes?: readonly ActionType[];
  /** Action types that require a digest-bound artifact. Defaults to `["deploy"]`. */
  readonly artifactRequiredActionTypes?: readonly ActionType[];
  /** Whether the plane tolerates `constraints.allowPrivilegeEscalation`. */
  readonly allowPrivilegeEscalation: boolean;
  /** Local TTL ceiling. Intents requesting longer than this are rejected. */
  readonly maxTtlSeconds: number;
}

const DEFAULT_ALLOWED_ACTIONS: readonly ActionType[] = [
  "deploy",
  "destroy",
  "inspect",
  "collectOutputs",
  "verifyTrust",
];
const DEFAULT_ARTIFACT_REQUIRED_ACTIONS: readonly ActionType[] = ["deploy"];

export type CustomerExecutionStage =
  | "intent-authenticity"
  | "intent-authorization"
  | "artifact-integrity"
  | "artifact-safety";

export type CustomerExecutionRejectionReason =
  | "audience-mismatch"
  | "account-not-allowed"
  | "region-not-allowed"
  | "action-type-not-allowed"
  | "problem-not-approved"
  | "privilege-escalation-forbidden"
  | "ttl-exceeds-local-max"
  | "policy-denied"
  | "policy-needs-approval"
  | "policy-error"
  | "artifact-missing"
  | "artifact-digest-mismatch"
  | "artifact-size-mismatch"
  | "artifact-rejected"
  | "artifact-inspection-error";

export interface CustomerExecutionAuthorized {
  readonly ok: true;
  /** Signature-verified, schema-valid, locally-authorized intent. */
  readonly intent: VerifiedCloudActionIntent;
  readonly policyDecision: PolicyDecision;
}

export interface CustomerExecutionRejected {
  readonly ok: false;
  readonly stage: CustomerExecutionStage;
  readonly reason: CustomerExecutionRejectionReason | IntentVerifyFailureReason;
  readonly details?: readonly string[];
  /**
   * Issue #1727: 認証 (signature/schema/TTL/replay) を通過した後の
   * 拒否 (authorization / artifact) には検証済み intent を添える。 監査ログに
   * tenant / problem / deployment の文脈を残すため。 authenticity 失敗時は intent が
   * 無いので undefined。
   */
  readonly intent?: VerifiedCloudActionIntent;
}

export type CustomerExecutionOutcome = CustomerExecutionAuthorized | CustomerExecutionRejected;

export interface CustomerExecutionPlaneOptions {
  readonly policy: CustomerExecutionPolicy;
  /** JWS verification inputs: `resolveSecret`, optional `nonceStore` (replay), `now`. */
  readonly verify: IntentVerifyOptions;
  /** 評価不能時に拒否する customer-local policy evaluator。 */
  readonly policyEvaluator: PolicyEvaluator;
  /** Optional fail-closed artifact safety check over the digest-verified bytes. */
  readonly artifactInspector?: ArtifactInspector;
}

export interface ClaimInput {
  /** Compact JWS serialization received from the hosted control plane. */
  readonly token: string;
  /** The candidate artifact bytes whose digest must match the signed intent. */
  readonly artifact?: { readonly bytes: Uint8Array };
}

/** `sha256:<64 lowercase hex>` over `bytes` — the on-the-wire digest shape. */
export function computeArtifactDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Schema + computeArtifactDigest both yield the fixed `sha256:`+64hex shape, so
  // lengths always match here; the guard keeps timingSafeEqual from throwing if
  // either side is ever loosened — provably unreachable through the validated path.
  /* v8 ignore start */
  if (ab.length !== bb.length) {
    return false;
  }
  /* v8 ignore stop */
  return timingSafeEqual(ab, bb);
}

export class CustomerExecutionPlane {
  private readonly options: CustomerExecutionPlaneOptions;

  constructor(options: CustomerExecutionPlaneOptions) {
    this.options = options;
  }

  /**
   * Validate a claimed intent through all four pre-execution stages. On success
   * the caller may exchange the verified intent for *local* authority (e.g. a
   * `MockCloudAdapter` / LocalStack / a same-account CloudFormation service role)
   * and deploy. This method never returns provider credentials and never assumes
   * a role trusted by the hosted control plane.
   */
  async authorize(input: ClaimInput): Promise<CustomerExecutionOutcome> {
    // Stage 1 — authenticity: signature, schema, TTL/notBefore, replay.
    const verified = await verifyIntent(input.token, this.options.verify);
    if (!verified.ok) {
      return {
        ok: false,
        stage: "intent-authenticity",
        reason: verified.reason,
        ...(verified.details ? { details: verified.details } : {}),
      };
    }
    const intent = verified.intent;

    // Stage 2 — authorization: a valid signature is NOT authorization.
    const authorization = await this.authorizeIntent(intent);
    if (!authorization.ok) {
      return { ...authorization.rejection, intent };
    }

    // Stages 3 + 4 — artifact integrity then safety.
    const artifactRejection = await this.checkArtifact(intent, input);
    if (artifactRejection) {
      return { ...artifactRejection, intent };
    }

    return { ok: true, intent, policyDecision: authorization.decision };
  }

  private async authorizeIntent(
    intent: VerifiedCloudActionIntent,
  ): Promise<
    | { readonly ok: true; readonly decision: PolicyDecision }
    | { readonly ok: false; readonly rejection: CustomerExecutionRejected }
  > {
    const localReason = checkLocalPolicy(intent, this.options.policy);
    if (localReason) {
      return { ok: false, rejection: reject("intent-authorization", localReason) };
    }

    let decision: PolicyDecision;
    try {
      decision = await this.options.policyEvaluator.evaluate(intent);
    } catch {
      // Fail closed: an evaluator that errors is treated as a denial.
      return { ok: false, rejection: reject("intent-authorization", "policy-error") };
    }
    // Fail closed: only an explicit "allow" authorizes. A malformed or unknown
    // verdict (undefined / missing / unexpected `decision`) is a denial, never a
    // silent pass — a buggy or hostile evaluator must not become an allow.
    const verdict = policyVerdict(decision);
    if (verdict === "deny") {
      return {
        ok: false,
        rejection: reject("intent-authorization", "policy-denied", detailOf(decision.reason)),
      };
    }
    if (verdict === "needs_approval") {
      return {
        ok: false,
        rejection: reject(
          "intent-authorization",
          "policy-needs-approval",
          detailOf(decision.reason),
        ),
      };
    }
    if (verdict === "invalid") {
      return { ok: false, rejection: reject("intent-authorization", "policy-error") };
    }
    return { ok: true, decision };
  }

  private async checkArtifact(
    intent: VerifiedCloudActionIntent,
    input: ClaimInput,
  ): Promise<CustomerExecutionRejected | null> {
    const artifactRequired = (
      this.options.policy.artifactRequiredActionTypes ?? DEFAULT_ARTIFACT_REQUIRED_ACTIONS
    ).includes(intent.action.type);
    if (!intent.action.artifact && !artifactRequired) {
      return null;
    }
    if (!intent.action.artifact) {
      return reject("artifact-integrity", "artifact-missing", [
        `action ${intent.action.type} requires a signed artifact digest`,
      ]);
    }
    if (!input.artifact) {
      return reject("artifact-integrity", "artifact-missing", [
        "no artifact bytes supplied to verify",
      ]);
    }
    const actual = computeArtifactDigest(input.artifact.bytes);
    if (!digestsEqual(actual, intent.action.artifact.digest)) {
      return reject("artifact-integrity", "artifact-digest-mismatch", [
        `expected ${intent.action.artifact.digest}, got ${actual}`,
      ]);
    }
    if (
      intent.action.artifact.sizeBytes !== undefined &&
      intent.action.artifact.sizeBytes !== input.artifact.bytes.byteLength
    ) {
      return reject("artifact-integrity", "artifact-size-mismatch", [
        `expected ${intent.action.artifact.sizeBytes} bytes, got ${input.artifact.bytes.byteLength}`,
      ]);
    }
    return this.inspectArtifact(intent, input.artifact.bytes);
  }

  private async inspectArtifact(
    intent: VerifiedCloudActionIntent,
    bytes: Uint8Array,
  ): Promise<CustomerExecutionRejected | null> {
    if (!this.options.artifactInspector) {
      return null;
    }
    let inspection: ArtifactInspection;
    try {
      inspection = await this.options.artifactInspector.inspect(intent, bytes);
    } catch {
      return reject("artifact-safety", "artifact-inspection-error");
    }
    // Fail closed: only an explicit "allow" passes. An explicit "deny" rejects
    // the bytes; anything malformed (undefined / unknown decision) is treated as
    // an inspection error, never a pass.
    const verdict = inspectionVerdict(inspection);
    if (verdict === "deny") {
      return reject("artifact-safety", "artifact-rejected", detailOf(inspection.reason));
    }
    if (verdict === "invalid") {
      return reject("artifact-safety", "artifact-inspection-error");
    }
    return null;
  }
}

/**
 * Normalize an untrusted PolicyEvaluator return into a known verdict. The plugin
 * boundary is untrusted at runtime, so a missing/unknown `decision` collapses to
 * "invalid" (→ fail closed) rather than being treated as an allow.
 */
function policyVerdict(decision: PolicyDecision): "allow" | "deny" | "needs_approval" | "invalid" {
  const value = (decision as { decision?: unknown } | undefined | null)?.decision;
  if (value === "allow" || value === "deny" || value === "needs_approval") {
    return value;
  }
  return "invalid";
}

/** Normalize an untrusted ArtifactInspector return; unknown shapes → "invalid". */
function inspectionVerdict(inspection: ArtifactInspection): "allow" | "deny" | "invalid" {
  const value = (inspection as { decision?: unknown } | undefined | null)?.decision;
  if (value === "allow" || value === "deny") {
    return value;
  }
  return "invalid";
}

/**
 * Synchronous customer-local authorization checks (everything except the async
 * PolicyEvaluator). Returns the first failing reason, or `null` if all pass.
 */
function checkLocalPolicy(
  intent: VerifiedCloudActionIntent,
  policy: CustomerExecutionPolicy,
): CustomerExecutionRejectionReason | null {
  if (intent.audience !== policy.audience) {
    return "audience-mismatch";
  }
  if (!policy.allowedProviderAccountRefs.includes(intent.target.providerAccountRef)) {
    return "account-not-allowed";
  }
  if (
    policy.allowedRegions !== undefined &&
    (intent.target.region === undefined || !policy.allowedRegions.includes(intent.target.region))
  ) {
    return "region-not-allowed";
  }
  const allowedActions = policy.allowedActionTypes ?? DEFAULT_ALLOWED_ACTIONS;
  if (!allowedActions.includes(intent.action.type)) {
    return "action-type-not-allowed";
  }
  if (
    intent.source.problemId === undefined ||
    !policy.approvedProblemIds.includes(intent.source.problemId)
  ) {
    return "problem-not-approved";
  }
  if (intent.constraints.allowPrivilegeEscalation && !policy.allowPrivilegeEscalation) {
    return "privilege-escalation-forbidden";
  }
  if (intent.constraints.ttlSeconds > policy.maxTtlSeconds) {
    return "ttl-exceeds-local-max";
  }
  return null;
}

function reject(
  stage: CustomerExecutionStage,
  reason: CustomerExecutionRejectionReason,
  details?: readonly string[],
): CustomerExecutionRejected {
  return { ok: false, stage, reason, ...(details ? { details } : {}) };
}

function detailOf(reason: string | undefined): readonly string[] | undefined {
  return reason ? [reason] : undefined;
}
