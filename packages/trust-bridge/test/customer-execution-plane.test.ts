import { describe, expect, it } from "vitest";
import {
  type ArtifactInspector,
  CustomerExecutionPlane,
  type CustomerExecutionPolicy,
  computeArtifactDigest,
  type PolicyEvaluator,
} from "../src/customer-execution-plane.js";
import { signIntent } from "../src/jws.js";
import { type CloudActionIntent, INTENT_VERSION } from "../src/schema.js";
import type { NonceStore } from "../src/verify.js";

const SECRET = new TextEncoder().encode("customer-execution-plane-test-secret-key");
const resolveSecret = () => SECRET;
const NOW = () => new Date("2026-05-15T19:00:00.000Z");

const APPROVED_BYTES = new TextEncoder().encode(
  "AWSTemplateFormatVersion: '2010-09-09'\nResources:\n  Bucket:\n    Type: AWS::S3::Bucket\n",
);
const APPROVED_DIGEST = computeArtifactDigest(APPROVED_BYTES);

function intent(overrides: Partial<CloudActionIntent> = {}): CloudActionIntent {
  return {
    version: INTENT_VERSION,
    requestId: "req-cep-1",
    nonce: `nonce-${Math.random()}`,
    audience: "customer-exec-plane://acme/challenge-ou",
    source: {
      system: "tenkacloud",
      tenantId: "t-acme",
      problemId: "stackstack",
      workloadId: "deploy-worker-1",
    },
    target: { provider: "aws", providerAccountRef: "111111111111", region: "us-east-1" },
    action: {
      type: "deploy",
      engine: "cloudformation",
      requestedScopes: ["cloudformation:CreateStack"],
      artifact: { digest: APPROVED_DIGEST, sizeBytes: APPROVED_BYTES.byteLength },
    },
    constraints: {
      ttlSeconds: 600,
      expiresAt: "2026-05-15T20:00:00.000Z",
      allowPrivilegeEscalation: false,
    },
    ...overrides,
  };
}

function token(i: CloudActionIntent = intent()): string {
  return signIntent(i, { secret: SECRET });
}

const allowEvaluator: PolicyEvaluator = {
  async evaluate() {
    return { decision: "allow", policyVersion: "test-1" };
  },
};

const policy: CustomerExecutionPolicy = {
  audience: "customer-exec-plane://acme/challenge-ou",
  allowedProviderAccountRefs: ["111111111111"],
  allowedRegions: ["us-east-1"],
  approvedProblemIds: ["stackstack", "hello-world-battle"],
  allowPrivilegeEscalation: false,
  maxTtlSeconds: 900,
};

function plane(
  overrides: {
    policy?: Partial<CustomerExecutionPolicy>;
    policyEvaluator?: PolicyEvaluator;
    artifactInspector?: ArtifactInspector;
    nonceStore?: NonceStore;
  } = {},
): CustomerExecutionPlane {
  return new CustomerExecutionPlane({
    policy: { ...policy, ...overrides.policy },
    verify: {
      resolveSecret,
      now: NOW,
      ...(overrides.nonceStore ? { nonceStore: overrides.nonceStore } : {}),
    },
    policyEvaluator: overrides.policyEvaluator ?? allowEvaluator,
    ...(overrides.artifactInspector ? { artifactInspector: overrides.artifactInspector } : {}),
  });
}

describe("CustomerExecutionPlane.authorize", () => {
  it("should authorize a valid, locally-approved, digest-matching deploy intent", async () => {
    const outcome = await plane().authorize({
      token: token(),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.intent.source.problemId).toBe("stackstack");
      expect(outcome.policyDecision.decision).toBe("allow");
    }
  });

  it("should reject a signature it did not sign (intent-authenticity)", async () => {
    const wrongSecret = new TextEncoder().encode("a-totally-different-secret-value-here");
    const cep = new CustomerExecutionPlane({
      policy,
      verify: { resolveSecret: () => wrongSecret, now: NOW },
      policyEvaluator: allowEvaluator,
    });
    const outcome = await cep.authorize({ token: token(), artifact: { bytes: APPROVED_BYTES } });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "intent-authenticity",
      reason: "jws-signature-mismatch",
    });
  });

  it("should reject an expired intent (intent-authenticity)", async () => {
    const expired = intent({
      constraints: {
        ttlSeconds: 600,
        expiresAt: "2026-05-15T18:00:00.000Z",
        allowPrivilegeEscalation: false,
      },
    });
    const outcome = await plane().authorize({
      token: token(expired),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome).toMatchObject({ ok: false, stage: "intent-authenticity", reason: "expired" });
  });

  it("should reject a replayed intent via the nonce store (intent-authenticity)", async () => {
    const seen = new Set<string>();
    const nonceStore: NonceStore = {
      async recordNonce(i) {
        if (seen.has(i.nonce)) {
          return "replay";
        }
        seen.add(i.nonce);
        return "accepted";
      },
    };
    const cep = plane({ nonceStore });
    const t = token();
    const first = await cep.authorize({ token: t, artifact: { bytes: APPROVED_BYTES } });
    const second = await cep.authorize({ token: t, artifact: { bytes: APPROVED_BYTES } });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({
      ok: false,
      stage: "intent-authenticity",
      reason: "nonce-replay",
    });
  });

  it("should surface schema-invalid details for a validly-signed but malformed payload (intent-authenticity)", async () => {
    // JWS signature is valid (signed with SECRET) but the payload is not a
    // CloudActionIntent, so verifyIntent returns schema-invalid + details.
    const malformed = {
      version: INTENT_VERSION,
      requestId: "missing-everything-else",
    } as unknown as CloudActionIntent;
    const outcome = await plane().authorize({ token: token(malformed) });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe("intent-authenticity");
      expect(outcome.reason).toBe("schema-invalid");
      expect((outcome.details ?? []).length).toBeGreaterThan(0);
    }
  });

  it("should reject an audience that is not this execution plane (intent-authorization)", async () => {
    const other = intent({ audience: "customer-exec-plane://someone-else" });
    const outcome = await plane().authorize({
      token: token(other),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "intent-authorization",
      reason: "audience-mismatch",
    });
  });

  it("should reject a target account outside the local allowlist even with a valid signature (intent-authorization)", async () => {
    // Core property: a hosted control-plane compromise that mints a perfectly
    // signed intent still cannot reach an account the customer did not approve.
    const elsewhere = intent({
      target: { provider: "aws", providerAccountRef: "999999999999", region: "us-east-1" },
    });
    const outcome = await plane().authorize({
      token: token(elsewhere),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "intent-authorization",
      reason: "account-not-allowed",
    });
  });

  it("should reject a region outside the local allowlist (intent-authorization)", async () => {
    const otherRegion = intent({
      target: { provider: "aws", providerAccountRef: "111111111111", region: "eu-west-1" },
    });
    const outcome = await plane().authorize({
      token: token(otherRegion),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "intent-authorization",
      reason: "region-not-allowed",
    });
  });

  it("should reject a problem id not locally approved (intent-authorization)", async () => {
    const i = intent();
    const unapproved = intent({ source: { ...i.source, problemId: "not-reviewed-yet" } });
    const outcome = await plane().authorize({
      token: token(unapproved),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "intent-authorization",
      reason: "problem-not-approved",
    });
  });

  it("should reject privilege escalation when local policy forbids it (intent-authorization)", async () => {
    const esc = intent({
      constraints: {
        ttlSeconds: 600,
        expiresAt: "2026-05-15T20:00:00.000Z",
        allowPrivilegeEscalation: true,
      },
    });
    const outcome = await plane().authorize({
      token: token(esc),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "intent-authorization",
      reason: "privilege-escalation-forbidden",
    });
  });

  it("should reject a ttl exceeding the local maximum (intent-authorization)", async () => {
    const longTtl = intent({
      constraints: {
        ttlSeconds: 3000,
        expiresAt: "2026-05-15T20:00:00.000Z",
        allowPrivilegeEscalation: false,
      },
    });
    const outcome = await plane().authorize({
      token: token(longTtl),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "intent-authorization",
      reason: "ttl-exceeds-local-max",
    });
  });

  it("should reject when the local PolicyEvaluator denies (intent-authorization)", async () => {
    const deny: PolicyEvaluator = {
      async evaluate() {
        return { decision: "deny", reason: "budget exceeded" };
      },
    };
    const outcome = await plane({ policyEvaluator: deny }).authorize({
      token: token(),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "intent-authorization",
      reason: "policy-denied",
      details: ["budget exceeded"],
    });
  });

  it("should reject when the local PolicyEvaluator requires approval (intent-authorization)", async () => {
    const gate: PolicyEvaluator = {
      async evaluate() {
        return { decision: "needs_approval" };
      },
    };
    const outcome = await plane({ policyEvaluator: gate }).authorize({
      token: token(),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "intent-authorization",
      reason: "policy-needs-approval",
    });
  });

  it("should fail closed when the local PolicyEvaluator throws (intent-authorization)", async () => {
    const boom: PolicyEvaluator = {
      async evaluate() {
        throw new Error("opa unreachable");
      },
    };
    const outcome = await plane({ policyEvaluator: boom }).authorize({
      token: token(),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "intent-authorization",
      reason: "policy-error",
    });
  });

  it("should fail closed when the PolicyEvaluator returns a malformed verdict (intent-authorization)", async () => {
    // A buggy/hostile evaluator must never become a silent allow.
    const undefinedDecision = { async evaluate() {} } as unknown as PolicyEvaluator;
    const unknownDecision = {
      async evaluate() {
        return { decision: "maybe" };
      },
    } as unknown as PolicyEvaluator;
    for (const evaluator of [undefinedDecision, unknownDecision]) {
      const outcome = await plane({ policyEvaluator: evaluator }).authorize({
        token: token(),
        artifact: { bytes: APPROVED_BYTES },
      });
      expect(outcome).toMatchObject({
        ok: false,
        stage: "intent-authorization",
        reason: "policy-error",
      });
    }
  });

  it("should reject a deploy whose artifact bytes are not supplied (artifact-integrity)", async () => {
    const outcome = await plane().authorize({ token: token() });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "artifact-integrity",
      reason: "artifact-missing",
    });
  });

  it("should reject a deploy intent that omits the signed artifact digest (artifact-integrity)", async () => {
    const noDigest = intent({
      action: {
        type: "deploy",
        engine: "cloudformation",
        requestedScopes: ["cloudformation:CreateStack"],
      },
    });
    const outcome = await plane().authorize({
      token: token(noDigest),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "artifact-integrity",
      reason: "artifact-missing",
    });
  });

  it("should reject tampered artifact bytes whose digest no longer matches (artifact-integrity)", async () => {
    const tampered = new TextEncoder().encode(
      "Resources:\n  Backdoor:\n    Type: AWS::IAM::User\n",
    );
    const outcome = await plane().authorize({ token: token(), artifact: { bytes: tampered } });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "artifact-integrity",
      reason: "artifact-digest-mismatch",
    });
  });

  it("should reject an artifact whose declared size does not match (artifact-integrity)", async () => {
    const wrongSize = intent({
      action: {
        type: "deploy",
        engine: "cloudformation",
        requestedScopes: ["cloudformation:CreateStack"],
        artifact: { digest: APPROVED_DIGEST, sizeBytes: 9 },
      },
    });
    const outcome = await plane().authorize({
      token: token(wrongSize),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "artifact-integrity",
      reason: "artifact-size-mismatch",
    });
  });

  it("should reject when the artifact inspector denies the approved bytes (artifact-safety)", async () => {
    const inspector: ArtifactInspector = {
      async inspect() {
        return { decision: "deny", reason: "creates IAM admin" };
      },
    };
    const outcome = await plane({ artifactInspector: inspector }).authorize({
      token: token(),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "artifact-safety",
      reason: "artifact-rejected",
      details: ["creates IAM admin"],
    });
  });

  it("should fail closed when the artifact inspector throws (artifact-safety)", async () => {
    const inspector: ArtifactInspector = {
      async inspect() {
        throw new Error("scanner crashed");
      },
    };
    const outcome = await plane({ artifactInspector: inspector }).authorize({
      token: token(),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "artifact-safety",
      reason: "artifact-inspection-error",
    });
  });

  it("should fail closed when the artifact inspector returns a malformed verdict (artifact-safety)", async () => {
    const undefinedDecision = { async inspect() {} } as unknown as ArtifactInspector;
    const unknownDecision = {
      async inspect() {
        return { decision: "probably-fine" };
      },
    } as unknown as ArtifactInspector;
    for (const inspector of [undefinedDecision, unknownDecision]) {
      const outcome = await plane({ artifactInspector: inspector }).authorize({
        token: token(),
        artifact: { bytes: APPROVED_BYTES },
      });
      expect(outcome).toMatchObject({
        ok: false,
        stage: "artifact-safety",
        reason: "artifact-inspection-error",
      });
    }
  });

  it("should authorize when the artifact inspector allows the bytes (artifact-safety)", async () => {
    const inspector: ArtifactInspector = {
      async inspect() {
        return { decision: "allow" };
      },
    };
    const outcome = await plane({ artifactInspector: inspector }).authorize({
      token: token(),
      artifact: { bytes: APPROVED_BYTES },
    });
    expect(outcome.ok).toBe(true);
  });

  it("should reject an action type the local policy does not permit (intent-authorization)", async () => {
    const inspect = intent({
      action: {
        type: "inspect",
        engine: "cloudformation",
        requestedScopes: ["cloudformation:DescribeStacks"],
      },
    });
    const outcome = await plane({
      policy: { allowedActionTypes: ["deploy", "destroy"] },
    }).authorize({
      token: token(inspect),
    });
    expect(outcome).toMatchObject({
      ok: false,
      stage: "intent-authorization",
      reason: "action-type-not-allowed",
    });
  });

  it("should authorize a destroy action without requiring artifact bytes", async () => {
    const destroy = intent({
      action: {
        type: "destroy",
        engine: "cloudformation",
        requestedScopes: ["cloudformation:DeleteStack"],
      },
    });
    const outcome = await plane().authorize({ token: token(destroy) });
    expect(outcome.ok).toBe(true);
  });
});
