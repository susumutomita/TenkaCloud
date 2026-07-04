import { verifyIntent } from "@TenkaCloud/trust-bridge";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import type { DeployDetailType } from "../../lib/intent-ingress/action-map";
import {
  type BuildIntentParams,
  buildDeployIntent,
  buildDestroyIntent,
  issueSignedIntentRequest,
} from "../../lib/intent-ingress/issuer";
import { handleIntentIngress, type IntentIngressDeps } from "../../lib/intent-ingress/orchestrator";
import { authorizeIntentScope } from "../../lib/intent-ingress/scope-authorization";

/**
 * ROUND-TRIP proof for the signed-intent ISSUER (ADR-049 Phase 4 / #2293).
 *
 * The crux of SLICE 5: an intent minted + signed by the issuer, fed as a raw POST body
 * into the REAL ingress orchestrator (SLICE 1) — with the REAL `verifyIntent`,
 * `authorizeIntentScope`, and detail-builder — must produce a 202 and the correct frozen
 * re-emitted event. This is what proves the sign-side is symmetric with the verify-side;
 * a scaffolded/decoupled test would not.
 */

/** Signing/verifying key shared by the issuer and the ingress `verify` dep. */
const SECRET = new TextEncoder().encode("issuer-roundtrip-secret-abcdef 0123456789");
/** A DIFFERENT key — proves a wrong verify secret is rejected, not accepted. */
const WRONG_SECRET = new TextEncoder().encode("wrong-issuer-roundtrip-secret-9876543210");

const EXPECTED_AUDIENCE = "plane://tenka/ingress";

/** Fake platform problems catalog: problemId → problemDir. */
const resolveProblemDir = (problemId: string): string | undefined =>
  ({ "hello-world": "problems/challenges/hello-world" })[problemId];

/** Issuer params whose identifiers resolve to a valid frozen deploy detail. */
function params(overrides: Partial<BuildIntentParams> = {}): BuildIntentParams {
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
    audience: EXPECTED_AUDIENCE,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ttlSeconds: 900,
    allowPrivilegeEscalation: false,
    requestedScopes: ["cloudformation:CreateStack"],
    ...overrides,
  };
}

interface Captured {
  detailType: DeployDetailType;
  jobId: string;
  detail: Record<string, unknown>;
}

/** Real ingress deps bound to `secret`, capturing the re-emitted event. */
function realDeps(secret: Uint8Array): { deps: IntentIngressDeps; captured: Captured[] } {
  const captured: Captured[] = [];
  const deps: IntentIngressDeps = {
    verify: (token) => verifyIntent(token, { resolveSecret: () => secret }),
    authorizeScope: (intent) =>
      authorizeIntentScope(intent, {
        expectedAudience: EXPECTED_AUDIENCE,
        allowedTenantIds: ["tenant-a", "tenant-b"],
        allowedEventIds: ["event-a"],
      }),
    resolveProblemDir,
    publish: async (detailType, jobId, detail) => {
      captured.push({ detailType, jobId, detail });
    },
  };
  return { deps, captured };
}

describe("issuer → ingress round-trip (ADR-049 Phase 4 / #2293)", () => {
  it("should issue a signed deploy intent the real ingress accepts as DeployCreateRequested", async () => {
    const intent = buildDeployIntent(params());
    const { body } = issueSignedIntentRequest(intent, { secret: SECRET });

    const { deps, captured } = realDeps(SECRET);
    const res = await handleIntentIngress(body, deps);

    expect(res.status).toBe(StatusCodes.ACCEPTED);
    expect(res.body).toEqual({ requestId: "job-abc" });
    expect(captured).toHaveLength(1);
    expect(captured[0].detailType).toBe("DeployCreateRequested");
    expect(captured[0].jobId).toBe("job-abc");
    expect(captured[0].detail).toEqual({
      jobId: "job-abc",
      correlationId: "job-abc",
      tenantId: "tenant-a",
      problemId: "hello-world",
      problemDir: "problems/challenges/hello-world",
      teamSlug: "team-alpha",
      namePrefix: "tc-hello-world-team-alpha",
      region: "us-east-1",
      awsAccountId: "111111111111",
    });
  });

  it("should issue a signed destroy intent the real ingress accepts as DeployDeleteRequested", async () => {
    const intent = buildDestroyIntent(params());
    const { body } = issueSignedIntentRequest(intent, { secret: SECRET });

    const { deps, captured } = realDeps(SECRET);
    const res = await handleIntentIngress(body, deps);

    expect(res.status).toBe(StatusCodes.ACCEPTED);
    expect(captured).toHaveLength(1);
    expect(captured[0].detailType).toBe("DeployDeleteRequested");
    expect(captured[0].detail).toEqual({
      jobId: "job-abc",
      correlationId: "job-abc",
      tenantId: "tenant-a",
      stackName: "tc-hello-world-team-alpha",
      region: "us-east-1",
      awsAccountId: "111111111111",
    });
  });

  it("should be rejected 401 when a single character of the signed token is flipped", async () => {
    const intent = buildDeployIntent(params());
    const { token } = issueSignedIntentRequest(intent, { secret: SECRET });
    // Flip the final signature character to a guaranteed-different one → HMAC mismatch.
    const lastChar = token.at(-1);
    const tampered = `${token.slice(0, -1)}${lastChar === "A" ? "B" : "A"}`;
    const body = JSON.stringify({ token: tampered });

    const { deps, captured } = realDeps(SECRET);
    const res = await handleIntentIngress(body, deps);

    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    expect(res.body).toEqual({ reason: "intent-unauthorized" });
    expect(captured).toHaveLength(0);
  });

  it("should be rejected 401 when the ingress verifies with the wrong secret", async () => {
    const intent = buildDeployIntent(params());
    const { body } = issueSignedIntentRequest(intent, { secret: SECRET });

    // Same untouched token, but the ingress resolves a DIFFERENT secret → signature mismatch.
    const { deps, captured } = realDeps(WRONG_SECRET);
    const res = await handleIntentIngress(body, deps);

    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    expect(res.body).toEqual({ reason: "intent-unauthorized" });
    expect(captured).toHaveLength(0);
  });
});
