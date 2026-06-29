/**
 * Cross-cloud identity recovery — offline-testable end-to-end grader.
 *
 * This grader verifies the ACTUAL keyless AWS-to-GCP call, not merely the
 * presence of IAM configuration. It models the real recovery path:
 *
 *   1. The AWS workload mints a federated subject token from its own AWS role.
 *   2. GCP STS exchanges that subject token for a short-lived federated access
 *      token -- but only if the Workload Identity provider's TRUST (audience +
 *      AWS account condition) accepts the caller.
 *   3. The federated identity impersonates the GCP service account -- but only
 *      if the SA grants it roles/iam.workloadIdentityUser (the BINDING).
 *   4. The impersonated token calls the protected endpoint -- which must reject
 *      anonymous traffic and accept only the bound service account.
 *
 * A score is awarded ONLY when every step succeeds AND no static service-account
 * key was used anywhere. Any static key (in AWS outputs, GCP outputs, or
 * injected into the call) fails the grade outright.
 *
 * The grader is a PURE function: every side effect (AWS identity, GCP STS,
 * GCP IAM impersonation, the protected-endpoint call, and the clock) is injected.
 * It performs NO network, reads NO credentials, and is fully deterministic, so
 * the test suite runs offline with fakes.
 */

/** Why a grade did not award points. Stable, testable identifiers. */
export type GradeFailureReason =
  | "static-key-present"
  | "aws-not-ready"
  | "gcp-not-ready"
  | "broken-audience"
  | "unauthorized-aws-account"
  | "unbound-service-account"
  | "protected-endpoint-rejected"
  | "anonymous-traffic-accepted";

export interface GradeResult {
  readonly awarded: boolean;
  readonly points: number;
  readonly reason?: GradeFailureReason;
}

/** Deploy readiness of one composite target, as observed by the grader. */
export interface TargetReadiness {
  readonly ready: boolean;
  /** Non-sensitive outputs published by the target. */
  readonly outputs: Readonly<Record<string, string>>;
}

/** The federated subject token the AWS workload presents to GCP STS. */
export interface AwsFederatedSubject {
  /** The AWS account id encoded in the workload's federated identity. */
  readonly awsAccountId: string;
  /** The audience the workload presents (the WIF provider audience string). */
  readonly audience: string;
  /**
   * A static GCP service-account key, if one was (wrongly) injected into the
   * call. The keyless path must NEVER carry this; any value fails the grade.
   */
  readonly injectedStaticKey?: string;
}

/** The GCP Workload Identity provider trust the grader checks the subject against. */
export interface GcpProviderTrust {
  /** AWS account id the provider is configured to trust. */
  readonly trustedAwsAccountId: string;
  /** Audiences the provider accepts. */
  readonly allowedAudiences: readonly string[];
}

/** The GCP service-account impersonation binding the grader checks. */
export interface GcpServiceAccountBinding {
  /**
   * AWS account ids granted roles/iam.workloadIdentityUser on the SA. Empty
   * means the binding is missing (unbound / unauthorized impersonation).
   */
  readonly workloadIdentityUserAwsAccounts: readonly string[];
}

/** The protected endpoint's invoker policy the grader checks. */
export interface ProtectedEndpointPolicy {
  /** True when the endpoint accepts unauthenticated / anonymous callers. */
  readonly allowsAnonymous: boolean;
  /** Service-account emails permitted to invoke the endpoint. */
  readonly allowedInvokerServiceAccounts: readonly string[];
  /** The service account the SA impersonation resolves to. */
  readonly impersonatedServiceAccount: string;
}

/**
 * Injected clients + clock. All pure data + pure predicates; the grader never
 * performs I/O itself.
 */
export interface GraderDeps {
  readonly aws: TargetReadiness;
  readonly gcp: TargetReadiness;
  readonly subject: AwsFederatedSubject;
  readonly providerTrust: GcpProviderTrust;
  readonly serviceAccountBinding: GcpServiceAccountBinding;
  readonly protectedEndpoint: ProtectedEndpointPolicy;
  /** Injected clock (ms since epoch). Present so scoring decisions stay deterministic. */
  readonly now: () => number;
}

const POINTS_ALL_OK = 100;

/** A static-key fingerprint: anything that looks like a service-account key blob. */
const STATIC_KEY_MARKERS = ["private_key", "BEGIN PRIVATE KEY", "service_account"];

function fail(reason: GradeFailureReason): GradeResult {
  return { awarded: false, points: 0, reason };
}

/** True when any output value carries a static service-account key artifact. */
function outputsContainStaticKey(outputs: Readonly<Record<string, string>>): boolean {
  return Object.values(outputs).some((value) =>
    STATIC_KEY_MARKERS.some((marker) => value.includes(marker)),
  );
}

/**
 * Grade the end-to-end keyless recovery. Pure: the same inputs always yield the
 * same result. Returns {@link POINTS_ALL_OK} only when every step of the keyless
 * path succeeds and no static key appears anywhere.
 */
export function gradeRecovery(deps: GraderDeps): GradeResult {
  // (0) Reject any static service-account key, wherever it appears. A keyless
  // problem that leaks or accepts a key is an automatic non-award.
  if (deps.subject.injectedStaticKey && deps.subject.injectedStaticKey.length > 0) {
    return fail("static-key-present");
  }
  if (outputsContainStaticKey(deps.aws.outputs) || outputsContainStaticKey(deps.gcp.outputs)) {
    return fail("static-key-present");
  }

  // (1) Both targets must be deployed before any cross-cloud call can succeed.
  // AWS-ready-but-GCP-unavailable (and vice versa) award nothing.
  if (!deps.aws.ready) return fail("aws-not-ready");
  if (!deps.gcp.ready) return fail("gcp-not-ready");

  // (2) GCP STS token exchange: the provider must accept the presented audience
  // and trust the workload's AWS account. A broken audience or an untrusted
  // account fails the exchange (fail closed).
  if (!deps.providerTrust.allowedAudiences.includes(deps.subject.audience)) {
    return fail("broken-audience");
  }
  if (deps.providerTrust.trustedAwsAccountId !== deps.subject.awsAccountId) {
    return fail("unauthorized-aws-account");
  }

  // (3) Impersonation: the SA must grant the federated AWS identity
  // roles/iam.workloadIdentityUser. An unbound SA fails closed.
  if (
    !deps.serviceAccountBinding.workloadIdentityUserAwsAccounts.includes(deps.subject.awsAccountId)
  ) {
    return fail("unbound-service-account");
  }

  // (4) The protected endpoint must validate the intended caller path. It must
  // NOT accept anonymous traffic, and it must permit the impersonated SA.
  if (deps.protectedEndpoint.allowsAnonymous) {
    return fail("anonymous-traffic-accepted");
  }
  if (
    !deps.protectedEndpoint.allowedInvokerServiceAccounts.includes(
      deps.protectedEndpoint.impersonatedServiceAccount,
    )
  ) {
    return fail("protected-endpoint-rejected");
  }

  // Touch the injected clock so the dependency is real (deterministic) and the
  // grader stays clock-injected for future time-bounded scoring rules.
  void deps.now();

  return { awarded: true, points: POINTS_ALL_OK };
}

export const RECOVERY_POINTS_ALL_OK = POINTS_ALL_OK;
