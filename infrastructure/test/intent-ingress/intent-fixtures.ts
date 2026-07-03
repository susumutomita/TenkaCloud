import {
  brandVerified,
  type CloudActionIntent,
  INTENT_VERSION,
  type VerifiedCloudActionIntent,
} from "@TenkaCloud/trust-bridge";

/** Shared HS256 secret for signing/verifying test intents. */
export const TEST_SECRET = new TextEncoder().encode("intent-ingress-test-secret-0123456789");

type Source = CloudActionIntent["source"];
type Target = CloudActionIntent["target"];
type Action = CloudActionIntent["action"];
type Constraints = CloudActionIntent["constraints"];

export interface IntentOverrides {
  readonly requestId?: string;
  readonly nonce?: string;
  readonly audience?: string;
  readonly source?: Partial<Source>;
  readonly target?: Partial<Target>;
  readonly action?: Partial<Action>;
  readonly constraints?: Partial<Constraints>;
}

/** A schema-valid deploy `CloudActionIntent`, overridable per sub-object. */
export function makeIntent(overrides: IntentOverrides = {}): CloudActionIntent {
  const source: Source = {
    system: "tenkacloud",
    tenantId: "tenant-a",
    workloadId: "workload-1",
    eventId: "event-a",
    teamId: "team-alpha",
    problemId: "hello-world",
    deploymentId: "job-abc",
    ...overrides.source,
  };
  const target: Target = {
    provider: "aws",
    providerAccountRef: "111111111111",
    region: "us-east-1",
    ...overrides.target,
  };
  const action: Action = {
    type: "deploy",
    engine: "cloudformation",
    requestedScopes: ["cloudformation:CreateStack"],
    ...overrides.action,
  };
  const constraints: Constraints = {
    ttlSeconds: 900,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    allowPrivilegeEscalation: false,
    ...overrides.constraints,
  };
  return {
    version: INTENT_VERSION,
    requestId: overrides.requestId ?? "job-abc",
    nonce: overrides.nonce ?? "nonce-01",
    ...(overrides.audience !== undefined ? { audience: overrides.audience } : {}),
    source,
    target,
    action,
    constraints,
  };
}

/** A verified (branded) intent for the offline scope / detail-builder tests. */
export function makeVerified(overrides: IntentOverrides = {}): VerifiedCloudActionIntent {
  return brandVerified(makeIntent(overrides));
}
