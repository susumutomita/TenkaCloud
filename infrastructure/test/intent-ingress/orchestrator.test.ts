import {
  type IntentVerifyOutcome,
  signIntent,
  type VerifiedCloudActionIntent,
  verifyIntent,
} from "@TenkaCloud/trust-bridge";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it, vi } from "vitest";
import type { DeployDetailType } from "../../lib/intent-ingress/action-map";
import { handleIntentIngress, type IntentIngressDeps } from "../../lib/intent-ingress/orchestrator";
import { authorizeIntentScope } from "../../lib/intent-ingress/scope-authorization";
import { makeIntent, makeVerified, TEST_SECRET } from "./intent-fixtures";

const resolveProblemDir = (problemId: string): string | undefined =>
  ({ "hello-world": "problems/challenges/hello-world" })[problemId];

const VERIFIED_ACCOUNT = {
  competitorRoleArn: "arn:aws:iam::111111111111:role/TenkaCloud-tenant-a-deploy-Role",
  externalIdParameterName: "/test/tenants/tenant-a/external-id",
} as const;

/** Deps that always verify to the given intent and always authorize; captures publishes. */
function fakeDeps(
  intent: VerifiedCloudActionIntent,
  overrides: Partial<IntentIngressDeps> = {},
): {
  deps: IntentIngressDeps;
  published: { detailType: DeployDetailType; jobId: string; detail: Record<string, unknown> }[];
} {
  const published: {
    detailType: DeployDetailType;
    jobId: string;
    detail: Record<string, unknown>;
  }[] = [];
  const deps: IntentIngressDeps = {
    verify: async () => ({ ok: true, intent }) satisfies IntentVerifyOutcome,
    authorizeScope: () => ({ ok: true }),
    resolveProblemDir,
    resolveVerifiedAccount: async () => VERIFIED_ACCOUNT,
    publish: async (detailType, jobId, detail) => {
      published.push({ detailType, jobId, detail });
    },
    ...overrides,
  };
  return { deps, published };
}

const body = (token: string): string => JSON.stringify({ token });

describe("handleIntentIngress (ADR-049 Phase 4 / #2293)", () => {
  it("should 400 malformed-request-body when the body is not JSON", async () => {
    const { deps } = fakeDeps(makeVerified());
    const res = await handleIntentIngress("not json", deps);
    expect(res).toEqual({
      status: StatusCodes.BAD_REQUEST,
      body: { reason: "malformed-request-body" },
    });
  });

  it("should 400 malformed-request-body when the token field is missing", async () => {
    const { deps } = fakeDeps(makeVerified());
    const res = await handleIntentIngress(JSON.stringify({ nope: 1 }), deps);
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(res.body).toEqual({ reason: "malformed-request-body" });
  });

  it("should 400 intent-schema-invalid on a schema verification failure", async () => {
    const { deps } = fakeDeps(makeVerified(), {
      verify: async () => ({ ok: false, reason: "schema-invalid" }),
    });
    const res = await handleIntentIngress(body("t"), deps);
    expect(res).toEqual({
      status: StatusCodes.BAD_REQUEST,
      body: { reason: "intent-schema-invalid" },
    });
  });

  it("should 401 intent-unauthorized on a signature mismatch (no oracle detail)", async () => {
    const { deps } = fakeDeps(makeVerified(), {
      verify: async () => ({ ok: false, reason: "jws-signature-mismatch" }),
    });
    const res = await handleIntentIngress(body("t"), deps);
    expect(res).toEqual({
      status: StatusCodes.UNAUTHORIZED,
      body: { reason: "intent-unauthorized" },
    });
  });

  it("should 401 intent-unauthorized when the intent is expired", async () => {
    const { deps } = fakeDeps(makeVerified(), {
      verify: async () => ({ ok: false, reason: "expired" }),
    });
    const res = await handleIntentIngress(body("t"), deps);
    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
  });

  // The remaining JWS/timing failure reasons all collapse to the same coarse
  // `intent-unauthorized` (no signature-vs-secret oracle). Exercise each so every
  // fall-through `case` in `verifyFailureResponse` is covered.
  const unauthorizedReasons = [
    "jws-malformed",
    "jws-unknown-algorithm",
    "jws-secret-not-resolved",
    "jws-payload-parse-failed",
    "not-yet-valid",
  ] as const;

  it.each(
    unauthorizedReasons,
  )("should 401 intent-unauthorized on a %s verification failure (no oracle detail)", async (reason) => {
    const { deps, published } = fakeDeps(makeVerified(), {
      verify: async () => ({ ok: false, reason }),
    });
    const res = await handleIntentIngress(body("t"), deps);
    expect(res).toEqual({
      status: StatusCodes.UNAUTHORIZED,
      body: { reason: "intent-unauthorized" },
    });
    expect(published).toHaveLength(0);
  });

  it("should 409 nonce-replay on a replayed nonce", async () => {
    const { deps } = fakeDeps(makeVerified(), {
      verify: async () => ({ ok: false, reason: "nonce-replay" }),
    });
    const res = await handleIntentIngress(body("t"), deps);
    expect(res).toEqual({ status: StatusCodes.CONFLICT, body: { reason: "nonce-replay" } });
  });

  it("should 403 when scope authorization rejects", async () => {
    const { deps } = fakeDeps(makeVerified(), {
      authorizeScope: () => ({ ok: false, reason: "tenant-not-allowed" }),
    });
    const res = await handleIntentIngress(body("t"), deps);
    expect(res).toEqual({
      status: StatusCodes.FORBIDDEN,
      body: { reason: "tenant-not-allowed" },
    });
  });

  it("should 422 not-a-deploy-command for a non-deploy action", async () => {
    const resolveVerifiedAccount = vi.fn();
    const { deps, published } = fakeDeps(makeVerified({ action: { type: "inspect" } }), {
      resolveVerifiedAccount,
    });
    const res = await handleIntentIngress(body("t"), deps);
    expect(res).toEqual({
      status: StatusCodes.UNPROCESSABLE_ENTITY,
      body: { reason: "not-a-deploy-command" },
    });
    expect(published).toHaveLength(0);
    expect(resolveVerifiedAccount).not.toHaveBeenCalled();
  });

  it.each([
    ["deploy", makeVerified()],
    ["destroy", makeVerified({ action: { type: "destroy" } })],
  ] as const)("should 403 account-not-verified without publishing for an unverified %s account", async (_action, intent) => {
    const publish = vi.fn();
    const resolveVerifiedAccount = vi.fn().mockResolvedValue(null);
    const { deps } = fakeDeps(intent, { publish, resolveVerifiedAccount });

    const res = await handleIntentIngress(body("t"), deps);

    expect(res).toEqual({
      status: StatusCodes.FORBIDDEN,
      body: { reason: "account-not-verified" },
    });
    expect(resolveVerifiedAccount).toHaveBeenCalledWith("tenant-a", "111111111111");
    expect(publish).not.toHaveBeenCalled();
  });

  it("should 422 with the build reason when a deploy intent lacks a problemId", async () => {
    const { deps } = fakeDeps(makeVerified({ source: { problemId: undefined } }));
    const res = await handleIntentIngress(body("t"), deps);
    expect(res).toEqual({
      status: StatusCodes.UNPROCESSABLE_ENTITY,
      body: { reason: "problem-id-missing" },
    });
  });

  it("should 500 event-publish-failed without leaking the raw error when publish throws", async () => {
    const { deps } = fakeDeps(makeVerified(), {
      publish: async () => {
        throw new Error("EventBridge is down: secret-ish detail");
      },
    });
    const res = await handleIntentIngress(body("t"), deps);
    expect(res).toEqual({
      status: StatusCodes.INTERNAL_SERVER_ERROR,
      body: { reason: "event-publish-failed" },
    });
  });

  it("should 202 and re-emit DeployCreateRequested for a valid deploy intent", async () => {
    const intent = makeVerified();
    const { deps, published } = fakeDeps(intent);
    const res = await handleIntentIngress(body("t"), deps);
    expect(res).toEqual({ status: StatusCodes.ACCEPTED, body: { requestId: "job-abc" } });
    expect(published).toHaveLength(1);
    expect(published[0].detailType).toBe("DeployCreateRequested");
    expect(published[0].jobId).toBe("job-abc");
    expect(published[0].detail).toMatchObject({
      problemId: "hello-world",
      problemDir: "problems/challenges/hello-world",
      teamSlug: "team-alpha",
      ...VERIFIED_ACCOUNT,
    });
  });

  it("should 202 and re-emit DeployDeleteRequested for a valid destroy intent", async () => {
    const intent = makeVerified({ action: { type: "destroy" } });
    const { deps, published } = fakeDeps(intent);
    const res = await handleIntentIngress(body("t"), deps);
    expect(res.status).toBe(StatusCodes.ACCEPTED);
    expect(published[0].detailType).toBe("DeployDeleteRequested");
    expect(published[0].detail).toMatchObject({
      stackName: "tc-hello-world-team-alpha",
      ...VERIFIED_ACCOUNT,
    });
  });

  it("should run end-to-end with the REAL verify + scope path on a genuinely signed intent", async () => {
    const token = signIntent(makeIntent(), { secret: TEST_SECRET });
    const published: Record<string, unknown>[] = [];
    const deps: IntentIngressDeps = {
      verify: (t) => verifyIntent(t, { resolveSecret: () => TEST_SECRET }),
      authorizeScope: (i) => authorizeIntentScope(i, { allowedTenantIds: ["tenant-a"] }),
      resolveProblemDir,
      resolveVerifiedAccount: async () => VERIFIED_ACCOUNT,
      publish: async (_detailType, _jobId, detail) => {
        published.push(detail);
      },
    };
    const res = await handleIntentIngress(body(token), deps);
    expect(res.status).toBe(StatusCodes.ACCEPTED);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      tenantId: "tenant-a",
      problemId: "hello-world",
      awsAccountId: "111111111111",
    });
  });

  it("should reject a tampered token through the REAL verify path", async () => {
    const token = signIntent(makeIntent(), { secret: TEST_SECRET });
    const tampered = `${token}x`;
    const verifySpy = vi.fn((t: string) => verifyIntent(t, { resolveSecret: () => TEST_SECRET }));
    const deps: IntentIngressDeps = {
      verify: verifySpy,
      authorizeScope: (i) => authorizeIntentScope(i, {}),
      resolveProblemDir,
      resolveVerifiedAccount: async () => VERIFIED_ACCOUNT,
      publish: async () => undefined,
    };
    const res = await handleIntentIngress(body(tampered), deps);
    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    expect(verifySpy).toHaveBeenCalledWith(tampered);
  });
});
