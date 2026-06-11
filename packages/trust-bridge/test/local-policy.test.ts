import { describe, expect, it } from "vitest";
import type { PolicyEvaluator } from "../src/customer-execution-plane.js";
import {
  combinePolicyEvaluators,
  createBudgetPolicyEvaluator,
  createCfnTemplateInspector,
} from "../src/local-policy.js";
import { brandVerified, type CloudActionIntent, INTENT_VERSION } from "../src/schema.js";

function intent(maxEstimatedCostUsd?: number) {
  const base: CloudActionIntent = {
    version: INTENT_VERSION,
    requestId: "r",
    nonce: "n",
    source: { system: "tenkacloud", tenantId: "t", workloadId: "w" },
    target: { provider: "aws", providerAccountRef: "1" },
    action: { type: "deploy", engine: "cloudformation", requestedScopes: [] },
    constraints: {
      ttlSeconds: 600,
      expiresAt: "2026-05-15T20:00:00.000Z",
      allowPrivilegeEscalation: false,
      ...(maxEstimatedCostUsd === undefined ? {} : { maxEstimatedCostUsd }),
    },
  };
  return brandVerified(base);
}

const fixed = (decision: "allow" | "deny" | "needs_approval"): PolicyEvaluator => ({
  async evaluate() {
    return { decision };
  },
});

describe("createBudgetPolicyEvaluator", () => {
  it("should allow when estimated cost is within the cap", async () => {
    const e = createBudgetPolicyEvaluator({ maxEstimatedCostUsd: 5, policyVersion: "v1" });
    expect(await e.evaluate(intent(3))).toEqual({ decision: "allow", policyVersion: "v1" });
  });

  it("should treat a missing cost as zero (allow)", async () => {
    const e = createBudgetPolicyEvaluator({ maxEstimatedCostUsd: 5 });
    expect(await e.evaluate(intent())).toEqual({ decision: "allow" });
  });

  it("should deny when estimated cost exceeds the cap", async () => {
    const e = createBudgetPolicyEvaluator({ maxEstimatedCostUsd: 5, policyVersion: "v1" });
    const d = await e.evaluate(intent(50));
    expect(d).toMatchObject({ decision: "deny", policyVersion: "v1" });
    expect(d.reason).toMatch(/exceeds local cap/);
  });

  it("should deny without a policyVersion when none is configured", async () => {
    const e = createBudgetPolicyEvaluator({ maxEstimatedCostUsd: 5 });
    const d = await e.evaluate(intent(50));
    expect(d.decision).toBe("deny");
    expect(d.policyVersion).toBeUndefined();
  });
});

describe("combinePolicyEvaluators", () => {
  it("should allow when every evaluator allows", async () => {
    const e = combinePolicyEvaluators(fixed("allow"), fixed("allow"));
    expect((await e.evaluate(intent())).decision).toBe("allow");
  });

  it("should allow when there are no evaluators", async () => {
    expect((await combinePolicyEvaluators().evaluate(intent())).decision).toBe("allow");
  });

  it("should short-circuit on the first deny", async () => {
    let secondCalled = false;
    const second: PolicyEvaluator = {
      async evaluate() {
        secondCalled = true;
        return { decision: "allow" };
      },
    };
    const e = combinePolicyEvaluators(fixed("deny"), second);
    expect((await e.evaluate(intent())).decision).toBe("deny");
    expect(secondCalled).toBe(false);
  });

  it("should escalate to needs_approval when no deny but an approval gate exists", async () => {
    const e = combinePolicyEvaluators(fixed("allow"), fixed("needs_approval"), fixed("allow"));
    expect((await e.evaluate(intent())).decision).toBe("needs_approval");
  });
});

describe("createCfnTemplateInspector", () => {
  const inspect = (text: string) =>
    createCfnTemplateInspector().inspect(intent(), new TextEncoder().encode(text));

  it("should allow a clean template", async () => {
    expect(await inspect("Resources:\n  B:\n    Type: AWS::S3::Bucket\n")).toEqual({
      decision: "allow",
    });
  });

  it("should deny a standalone IAM user", async () => {
    const r = await inspect("Resources:\n  U:\n    Type: AWS::IAM::User\n");
    expect(r).toMatchObject({ decision: "deny" });
    expect(r.reason).toMatch(/iam-user/);
  });

  it("should deny an IAM access key", async () => {
    expect((await inspect("Type: AWS::IAM::AccessKey")).decision).toBe("deny");
  });

  it("should deny an AdministratorAccess attachment", async () => {
    expect(
      (await inspect("ManagedPolicyArns: [arn:aws:iam::aws:policy/AdministratorAccess]")).decision,
    ).toBe("deny");
  });

  it("should honor a custom forbidden pattern list", async () => {
    const inspector = createCfnTemplateInspector({
      forbiddenPatterns: [{ id: "no-nat-gw", pattern: /AWS::EC2::NatGateway/ }],
    });
    expect(
      (await inspector.inspect(intent(), new TextEncoder().encode("AWS::IAM::User"))).decision,
    ).toBe("allow");
    expect(
      (await inspector.inspect(intent(), new TextEncoder().encode("Type: AWS::EC2::NatGateway")))
        .decision,
    ).toBe("deny");
  });
});
