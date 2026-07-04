import { INTENT_VERSION, parseCloudActionIntent, verifySignature } from "@TenkaCloud/trust-bridge";
import { describe, expect, it } from "vitest";
import {
  type BuildIntentParams,
  buildDeployIntent,
  buildDestroyIntent,
  buildIntentRequestBody,
  issueSignedIntentRequest,
} from "../../lib/intent-ingress/issuer";
import { TEST_SECRET } from "./intent-fixtures";

/**
 * Unit tests for the signed-intent ISSUER (ADR-049 Phase 4 / #2293). The round-trip
 * through the REAL ingress orchestrator lives in `issuer-roundtrip.test.ts`; here we
 * pin the built intent's shape, the fail-loud schema behaviour, and the request-body /
 * signing helpers.
 */

/** A fully-populated, schema-valid deploy/destroy parameter set. */
function fullParams(overrides: Partial<BuildIntentParams> = {}): BuildIntentParams {
  return {
    tenantId: "tenant-a",
    workloadId: "workload-1",
    problemId: "hello-world",
    deploymentId: "job-abc",
    teamId: "team-alpha",
    eventId: "event-a",
    providerAccountRef: "111111111111",
    region: "us-east-1",
    requestId: "job-abc",
    nonce: "nonce-01",
    audience: "plane://tenka/ingress",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ttlSeconds: 900,
    allowPrivilegeEscalation: true,
    requestedScopes: ["cloudformation:CreateStack"],
    ...overrides,
  };
}

/** The minimal required parameter set: every optional field omitted. */
function minimalParams(overrides: Partial<BuildIntentParams> = {}): BuildIntentParams {
  return {
    tenantId: "tenant-a",
    workloadId: "workload-1",
    problemId: "hello-world",
    deploymentId: "job-abc",
    providerAccountRef: "111111111111",
    requestId: "job-abc",
    nonce: "nonce-01",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ttlSeconds: 900,
    requestedScopes: ["cloudformation:CreateStack"],
    ...overrides,
  };
}

describe("buildDeployIntent (ADR-049 Phase 4 / #2293)", () => {
  it("should build a schema-valid deploy intent pinned to version/engine/type", () => {
    const intent = buildDeployIntent(fullParams());
    // Re-parse to prove it satisfies the authoritative `.strict()` schema.
    expect(parseCloudActionIntent(intent).ok).toBe(true);
    expect(intent.version).toBe(INTENT_VERSION);
    expect(intent.action.type).toBe("deploy");
    expect(intent.action.engine).toBe("cloudformation");
    expect(intent.target.provider).toBe("aws");
  });

  it("should carry every populated identifier into source/target/constraints", () => {
    const intent = buildDeployIntent(fullParams());
    expect(intent).toEqual({
      version: INTENT_VERSION,
      requestId: "job-abc",
      nonce: "nonce-01",
      audience: "plane://tenka/ingress",
      source: {
        system: "tenkacloud",
        tenantId: "tenant-a",
        workloadId: "workload-1",
        problemId: "hello-world",
        deploymentId: "job-abc",
        teamId: "team-alpha",
        eventId: "event-a",
      },
      target: {
        provider: "aws",
        providerAccountRef: "111111111111",
        region: "us-east-1",
      },
      action: {
        type: "deploy",
        engine: "cloudformation",
        requestedScopes: ["cloudformation:CreateStack"],
      },
      constraints: {
        ttlSeconds: 900,
        expiresAt: intent.constraints.expiresAt,
        allowPrivilegeEscalation: true,
      },
    });
  });

  it("should omit optional fields and default allowPrivilegeEscalation to false", () => {
    const intent = buildDeployIntent(minimalParams());
    // Optional axes are absent entirely (not set to undefined) so `.strict()` stays happy.
    expect("audience" in intent).toBe(false);
    expect("teamId" in intent.source).toBe(false);
    expect("eventId" in intent.source).toBe(false);
    expect("region" in intent.target).toBe(false);
    expect(intent.constraints.allowPrivilegeEscalation).toBe(false);
    expect(parseCloudActionIntent(intent).ok).toBe(true);
  });

  it("should throw loudly (no silent coercion) when a parameter violates the schema", () => {
    // An empty tenantId fails `source.tenantId` min(1); the parse issue is surfaced in the throw.
    expect(() => buildDeployIntent(fullParams({ tenantId: "" }))).toThrow(/source\.tenantId/);
  });

  it("should throw when ttlSeconds is out of the schema's 1..3600 range", () => {
    expect(() => buildDeployIntent(fullParams({ ttlSeconds: 99_999 }))).toThrow(
      /invalid CloudActionIntent/,
    );
  });
});

describe("buildDestroyIntent (ADR-049 Phase 4 / #2293)", () => {
  it("should build a schema-valid destroy intent with action.type=destroy", () => {
    const intent = buildDestroyIntent(fullParams());
    expect(parseCloudActionIntent(intent).ok).toBe(true);
    expect(intent.action.type).toBe("destroy");
    expect(intent.action.engine).toBe("cloudformation");
  });

  it("should throw loudly when a destroy parameter violates the schema", () => {
    expect(() => buildDestroyIntent(fullParams({ providerAccountRef: "" }))).toThrow(
      /target\.providerAccountRef/,
    );
  });
});

describe("buildIntentRequestBody (ADR-049 Phase 4 / #2293)", () => {
  it("should wrap the token in the exact { token } envelope the ingress parses", () => {
    expect(buildIntentRequestBody("compact.jws.token")).toBe(
      JSON.stringify({ token: "compact.jws.token" }),
    );
    expect(JSON.parse(buildIntentRequestBody("abc"))).toEqual({ token: "abc" });
  });
});

describe("issueSignedIntentRequest (ADR-049 Phase 4 / #2293)", () => {
  it("should sign the intent and return a verifiable token plus its request body", () => {
    const intent = buildDeployIntent(fullParams());
    const { token, body } = issueSignedIntentRequest(intent, { secret: TEST_SECRET });

    // The body is exactly the ingress envelope wrapping the returned token.
    expect(JSON.parse(body)).toEqual({ token });

    // The token is a compact JWS that verifies under the same secret.
    const outcome = verifySignature(token, { resolveSecret: () => TEST_SECRET });
    expect(outcome.ok).toBe(true);
  });

  it("should thread a kid through to the JWS header when provided", () => {
    const intent = buildDeployIntent(fullParams());
    const { token } = issueSignedIntentRequest(intent, { secret: TEST_SECRET, kid: "key-2026" });
    const outcome = verifySignature(token, { resolveSecret: () => TEST_SECRET });
    expect(outcome.ok && outcome.header.kid).toBe("key-2026");
  });
});
