import { describe, expect, it } from "vitest";
import type { CloudActionAuditRecord } from "../src/audit.js";
import { type CfnDeployClient, CloudFormationExecutor } from "../src/cloudformation-executor.js";
import { CustomerExecutionAgent } from "../src/customer-execution-agent.js";
import {
  CustomerExecutionPlane,
  type CustomerExecutionPolicy,
  computeArtifactDigest,
  type PolicyEvaluator,
} from "../src/customer-execution-plane.js";
import { signIntent } from "../src/jws.js";
import { type CloudActionIntent, INTENT_VERSION } from "../src/schema.js";

const SECRET = new TextEncoder().encode("agent-test-secret-key-hs256-000000");
const NOW = () => new Date("2026-05-15T19:00:00.000Z");
const BYTES = new TextEncoder().encode("AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n");
const DIGEST = computeArtifactDigest(BYTES);

function intent(overrides: Partial<CloudActionIntent> = {}): CloudActionIntent {
  return {
    version: INTENT_VERSION,
    requestId: "req-1",
    nonce: `n-${Math.random()}`,
    audience: "plane://acme",
    source: {
      system: "tenkacloud",
      tenantId: "t-acme",
      problemId: "net-evo-01-reachability",
      deploymentId: "dep-1",
      workloadId: "w-1",
    },
    target: { provider: "aws", providerAccountRef: "111111111111", region: "us-east-1" },
    action: {
      type: "deploy",
      engine: "cloudformation",
      requestedScopes: ["cloudformation:CreateStack"],
      artifact: { digest: DIGEST, sizeBytes: BYTES.byteLength },
    },
    constraints: {
      ttlSeconds: 600,
      expiresAt: "2026-05-15T20:00:00.000Z",
      allowPrivilegeEscalation: false,
    },
    ...overrides,
  };
}

const POLICY: CustomerExecutionPolicy = {
  audience: "plane://acme",
  allowedProviderAccountRefs: ["111111111111"],
  allowedRegions: ["us-east-1"],
  approvedProblemIds: ["net-evo-01-reachability"],
  allowPrivilegeEscalation: false,
  maxTtlSeconds: 900,
};

function cfnClient(overrides: Partial<CfnDeployClient> = {}): CfnDeployClient {
  return {
    createStack: async () => ({ StackId: "stack/abc" }),
    updateStack: async () => ({}),
    deleteStack: async () => {},
    ...overrides,
  };
}

function makeAgent(opts: { policyEvaluator: PolicyEvaluator; cfn?: CfnDeployClient }): {
  agent: CustomerExecutionAgent;
  audits: CloudActionAuditRecord[];
} {
  const audits: CloudActionAuditRecord[] = [];
  const plane = new CustomerExecutionPlane({
    policy: POLICY,
    verify: { resolveSecret: () => SECRET, now: NOW },
    policyEvaluator: opts.policyEvaluator,
  });
  const executor = new CloudFormationExecutor({
    client: opts.cfn ?? cfnClient(),
    executionRoleArn: "arn:aws:iam::1:role/cfn",
  });
  const agent = new CustomerExecutionAgent({
    plane,
    executor,
    audit: (r) => {
      audits.push(r);
    },
    now: NOW,
  });
  return { agent, audits };
}

const allowEvaluator: PolicyEvaluator = {
  async evaluate() {
    return { decision: "allow", policyVersion: "v1" };
  },
};

describe("CustomerExecutionAgent", () => {
  it("should authorize, deploy via local CFn, and audit the allow", async () => {
    const { agent, audits } = makeAgent({ policyEvaluator: allowEvaluator });
    const out = await agent.run({
      token: signIntent(intent(), { secret: SECRET }),
      artifact: { bytes: BYTES },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result).toMatchObject({ action: "created", stackId: "stack/abc" });
      expect(out.intent.source.problemId).toBe("net-evo-01-reachability");
    }
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      decision: "allow",
      tenantId: "t-acme",
      problemId: "net-evo-01-reachability",
      action: "deploy",
      policyVersion: "v1",
      createdAt: "2026-05-15T19:00:00.000Z",
    });
  });

  it("should omit policyVersion in the audit when the evaluator gives none", async () => {
    const noVersion: PolicyEvaluator = {
      async evaluate() {
        return { decision: "allow" };
      },
    };
    const { agent, audits } = makeAgent({ policyEvaluator: noVersion });
    await agent.run({
      token: signIntent(intent(), { secret: SECRET }),
      artifact: { bytes: BYTES },
    });
    expect(audits[0].policyVersion).toBeUndefined();
  });

  it("should audit a post-authentication denial with tenant/problem context", async () => {
    const { agent, audits } = makeAgent({ policyEvaluator: allowEvaluator });
    // valid signature, but a different (un-approved) account → authorization denial.
    const wrong = intent({
      target: { provider: "aws", providerAccountRef: "999999999999", region: "us-east-1" },
    });
    const out = await agent.run({
      token: signIntent(wrong, { secret: SECRET }),
      artifact: { bytes: BYTES },
    });
    expect(out).toMatchObject({
      ok: false,
      stage: "intent-authorization",
      reason: "account-not-allowed",
    });
    expect(audits[0]).toMatchObject({
      decision: "deny",
      tenantId: "t-acme",
      problemId: "net-evo-01-reachability",
      denialReason: "intent-authorization:account-not-allowed",
    });
  });

  it("should audit an authenticity denial as an unknown deny (no intent context)", async () => {
    const { agent, audits } = makeAgent({ policyEvaluator: allowEvaluator });
    const wrongSecret = new TextEncoder().encode("not-the-signing-secret-at-all-000");
    const out = await agent.run({
      token: signIntent(intent(), { secret: wrongSecret }),
      artifact: { bytes: BYTES },
    });
    expect(out).toMatchObject({
      ok: false,
      stage: "intent-authenticity",
      reason: "jws-signature-mismatch",
    });
    expect(audits[0]).toMatchObject({
      decision: "deny",
      tenantId: "unknown",
      provider: "unknown",
      denialReason: "jws-signature-mismatch",
    });
  });

  it("should surface rejection details when the plane provides them", async () => {
    const denyWithReason: PolicyEvaluator = {
      async evaluate() {
        return { decision: "deny", reason: "budget exceeded" };
      },
    };
    const { agent } = makeAgent({ policyEvaluator: denyWithReason });
    const out = await agent.run({
      token: signIntent(intent(), { secret: SECRET }),
      artifact: { bytes: BYTES },
    });
    expect(out).toMatchObject({
      ok: false,
      stage: "intent-authorization",
      reason: "policy-denied",
      details: ["budget exceeded"],
    });
  });

  it("should default the audit clock to the real time when no clock is injected", async () => {
    const audits: CloudActionAuditRecord[] = [];
    const plane = new CustomerExecutionPlane({
      policy: POLICY,
      verify: { resolveSecret: () => SECRET, now: NOW },
      policyEvaluator: allowEvaluator,
    });
    const agent = new CustomerExecutionAgent({
      plane,
      executor: new CloudFormationExecutor({ client: cfnClient() }),
      audit: (r) => {
        audits.push(r);
      },
      // no `now` → constructor falls back to () => new Date()
    });
    await agent.run({
      token: signIntent(intent(), { secret: SECRET }),
      artifact: { bytes: BYTES },
    });
    expect(audits[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("should propagate an executor failure", async () => {
    const { agent } = makeAgent({
      policyEvaluator: allowEvaluator,
      cfn: cfnClient({
        createStack: async () => {
          throw new Error("CFn AccessDenied");
        },
      }),
    });
    await expect(
      agent.run({ token: signIntent(intent(), { secret: SECRET }), artifact: { bytes: BYTES } }),
    ).rejects.toThrow(/AccessDenied/);
  });
});
