import { describe, expect, it } from "vitest";
import {
  type CloudActionPolicy,
  type CloudActionRiskContext,
  evaluateCloudActionRisk,
} from "../src/cloud-action-policy.js";
import { type CloudActionIntent, INTENT_VERSION } from "../src/schema.js";

function intent(actionType: CloudActionIntent["action"]["type"] = "deploy"): CloudActionIntent {
  return {
    version: INTENT_VERSION,
    requestId: "r",
    nonce: "n",
    source: { system: "tenkacloud", tenantId: "t", workloadId: "w" },
    target: { provider: "aws", providerAccountRef: "123456789012" },
    action: { type: actionType, engine: "cloudformation", requestedScopes: [] },
    constraints: {
      ttlSeconds: 600,
      expiresAt: "2026-06-24T20:00:00.000Z",
      allowPrivilegeEscalation: false,
    },
  };
}

const SHADOW: CloudActionPolicy = { enforcementMode: "shadow" };

describe("evaluateCloudActionRisk — shadow mode (default, opt-in safety valve)", () => {
  it("should always allow in shadow mode even if a rule would otherwise match", () => {
    const policy: CloudActionPolicy = {
      enforcementMode: "shadow",
      requireApprovalFor: [{ actionType: "deploy" }],
    };
    expect(evaluateCloudActionRisk(intent("deploy"), policy, { isBulk: true })).toBe("allow");
  });

  it("should allow in shadow mode with no rules and no context", () => {
    expect(evaluateCloudActionRisk(intent(), SHADOW)).toBe("allow");
  });
});

describe("evaluateCloudActionRisk — enforce mode", () => {
  it("should allow when there are no requireApprovalFor rules", () => {
    expect(evaluateCloudActionRisk(intent("deploy"), { enforcementMode: "enforce" })).toBe("allow");
  });

  it("should allow when the rule list is present but empty", () => {
    const policy: CloudActionPolicy = { enforcementMode: "enforce", requireApprovalFor: [] };
    expect(evaluateCloudActionRisk(intent("deploy"), policy)).toBe("allow");
  });

  it("should hold (needs_approval) when an unconditional rule matches the action type", () => {
    const policy: CloudActionPolicy = {
      enforcementMode: "enforce",
      requireApprovalFor: [{ actionType: "deploy" }],
    };
    expect(evaluateCloudActionRisk(intent("deploy"), policy)).toBe("needs_approval");
  });

  it("should allow when the rule targets a different action type", () => {
    const policy: CloudActionPolicy = {
      enforcementMode: "enforce",
      requireApprovalFor: [{ actionType: "destroy" }],
    };
    expect(evaluateCloudActionRisk(intent("deploy"), policy)).toBe("allow");
  });

  it("should hold when a later rule in the list matches even though the first does not", () => {
    const policy: CloudActionPolicy = {
      enforcementMode: "enforce",
      requireApprovalFor: [{ actionType: "destroy" }, { actionType: "deploy" }],
    };
    expect(evaluateCloudActionRisk(intent("deploy"), policy)).toBe("needs_approval");
  });

  it("should treat an empty conditions object as an unconditional match", () => {
    const policy: CloudActionPolicy = {
      enforcementMode: "enforce",
      requireApprovalFor: [{ actionType: "deploy", conditions: {} }],
    };
    expect(evaluateCloudActionRisk(intent("deploy"), policy)).toBe("needs_approval");
  });
});

describe("evaluateCloudActionRisk — condition AND-matching (every branch)", () => {
  const conditionKeys: readonly (keyof CloudActionRiskContext)[] = [
    "isBulk",
    "isRetry",
    "isForceRedeploy",
    "replacesExistingStack",
  ];

  for (const key of conditionKeys) {
    it(`should hold when the rule requires ${key} and the context sets ${key}=true`, () => {
      const policy: CloudActionPolicy = {
        enforcementMode: "enforce",
        requireApprovalFor: [{ actionType: "deploy", conditions: { [key]: true } }],
      };
      expect(evaluateCloudActionRisk(intent("deploy"), policy, { [key]: true })).toBe(
        "needs_approval",
      );
    });

    it(`should allow when the rule requires ${key} but the context omits it`, () => {
      const policy: CloudActionPolicy = {
        enforcementMode: "enforce",
        requireApprovalFor: [{ actionType: "deploy", conditions: { [key]: true } }],
      };
      expect(evaluateCloudActionRisk(intent("deploy"), policy, {})).toBe("allow");
    });

    it(`should allow when the rule requires ${key} but the context sets ${key}=false`, () => {
      const policy: CloudActionPolicy = {
        enforcementMode: "enforce",
        requireApprovalFor: [{ actionType: "deploy", conditions: { [key]: true } }],
      };
      expect(evaluateCloudActionRisk(intent("deploy"), policy, { [key]: false })).toBe("allow");
    });
  }

  it("should require ALL pinned conditions (AND), not just one", () => {
    const policy: CloudActionPolicy = {
      enforcementMode: "enforce",
      requireApprovalFor: [
        { actionType: "deploy", conditions: { isBulk: true, replacesExistingStack: true } },
      ],
    };
    // Only one of the two required conditions is met → not held.
    expect(evaluateCloudActionRisk(intent("deploy"), policy, { isBulk: true })).toBe("allow");
    // Both required conditions met → held.
    expect(
      evaluateCloudActionRisk(intent("deploy"), policy, {
        isBulk: true,
        replacesExistingStack: true,
      }),
    ).toBe("needs_approval");
  });

  it("should ignore context flags the rule does not pin", () => {
    const policy: CloudActionPolicy = {
      enforcementMode: "enforce",
      requireApprovalFor: [{ actionType: "deploy", conditions: { replacesExistingStack: true } }],
    };
    // isBulk is set but irrelevant; only replacesExistingStack is required.
    expect(
      evaluateCloudActionRisk(intent("deploy"), policy, {
        isBulk: true,
        replacesExistingStack: true,
      }),
    ).toBe("needs_approval");
  });

  it("should default the context argument to no facts (safe baseline) when omitted", () => {
    const policy: CloudActionPolicy = {
      enforcementMode: "enforce",
      requireApprovalFor: [{ actionType: "deploy", conditions: { replacesExistingStack: true } }],
    };
    // No context passed → replacesExistingStack is treated as false → allow.
    expect(evaluateCloudActionRisk(intent("deploy"), policy)).toBe("allow");
  });
});
