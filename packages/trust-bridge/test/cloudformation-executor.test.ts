import { describe, expect, it } from "vitest";
import {
  type CfnDeployClient,
  type CfnStackMutationInput,
  CloudFormationExecutor,
  deriveStackName,
} from "../src/cloudformation-executor.js";
import { brandVerified, type CloudActionIntent, INTENT_VERSION } from "../src/schema.js";

function intent(overrides: Partial<CloudActionIntent> = {}) {
  const base: CloudActionIntent = {
    version: INTENT_VERSION,
    requestId: "req-1",
    nonce: "n-1",
    source: {
      system: "tenkacloud",
      tenantId: "t-acme",
      problemId: "net-evo-01-reachability",
      deploymentId: "dep-007",
      workloadId: "w-1",
    },
    target: { provider: "aws", providerAccountRef: "111111111111", region: "us-east-1" },
    action: { type: "deploy", engine: "cloudformation", requestedScopes: ["cfn:CreateStack"] },
    constraints: {
      ttlSeconds: 600,
      expiresAt: "2026-05-15T20:00:00.000Z",
      allowPrivilegeEscalation: false,
    },
    ...overrides,
  };
  return brandVerified(base);
}

class NamedError extends Error {
  constructor(name: string, message = name) {
    super(message);
    this.name = name;
  }
}

const TEMPLATE = "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n";

function client(overrides: Partial<CfnDeployClient> = {}): CfnDeployClient & {
  created: CfnStackMutationInput[];
  updated: CfnStackMutationInput[];
  deleted: { StackName: string; RoleARN?: string }[];
} {
  const created: CfnStackMutationInput[] = [];
  const updated: CfnStackMutationInput[] = [];
  const deleted: { StackName: string; RoleARN?: string }[] = [];
  return {
    created,
    updated,
    deleted,
    createStack: async (i) => {
      created.push(i);
      return { StackId: "stack/created" };
    },
    updateStack: async (i) => {
      updated.push(i);
      return { StackId: "stack/updated" };
    },
    deleteStack: async (i) => {
      deleted.push(i);
    },
    ...overrides,
  };
}

describe("deriveStackName", () => {
  it("should compose tc-<problemId>-<deploymentId>", () => {
    expect(deriveStackName(intent(), "tc")).toBe("tc-net-evo-01-reachability-dep-007");
  });

  it("should fall back to requestId when problem/deployment ids are absent", () => {
    const i = intent({ source: { system: "tenkacloud", tenantId: "t", workloadId: "w" } });
    expect(deriveStackName(i, "tc")).toBe("tc-req-1");
  });

  it("should sanitize to CFn naming and start with a letter", () => {
    const i = intent({
      source: { system: "tenkacloud", tenantId: "t", problemId: "p_!@#x", workloadId: "w" },
      requestId: "r",
    });
    expect(deriveStackName(i, "tc")).toMatch(/^[A-Za-z][A-Za-z0-9-]*$/);
  });

  it("should yield an empty name when prefix and suffix sanitize away (guard branch)", () => {
    const i = intent({
      source: { system: "tenkacloud", tenantId: "t", workloadId: "w" },
      requestId: "!!!",
    });
    expect(deriveStackName(i, "")).toBe("");
  });
});

describe("CloudFormationExecutor", () => {
  it("should create a new stack with default capabilities + service role", async () => {
    const c = client();
    const exec = new CloudFormationExecutor({
      client: c,
      executionRoleArn: "arn:aws:iam::1:role/cfn",
    });
    const res = await exec.execute(intent(), TEMPLATE);
    expect(res).toEqual({
      action: "created",
      stackName: "tc-net-evo-01-reachability-dep-007",
      stackId: "stack/created",
    });
    expect(c.created[0]).toMatchObject({
      TemplateBody: TEMPLATE,
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      RoleARN: "arn:aws:iam::1:role/cfn",
    });
  });

  it("should update when the stack already exists", async () => {
    const c = client({
      createStack: async () => {
        throw new NamedError("AlreadyExistsException");
      },
    });
    const res = await exec(c).execute(intent(), TEMPLATE);
    expect(res).toMatchObject({ action: "updated", stackId: "stack/updated" });
    expect(c.updated).toHaveLength(1);
  });

  it("should treat a CFn 'No updates' ValidationError as a no-op success", async () => {
    const c = client({
      createStack: async () => {
        throw new NamedError("AlreadyExistsException");
      },
      updateStack: async () => {
        throw new NamedError("ValidationError", "No updates are to be performed.");
      },
    });
    const res = await exec(c).execute(intent(), TEMPLATE);
    expect(res).toEqual({ action: "no-op", stackName: "tc-net-evo-01-reachability-dep-007" });
  });

  it("should delete the stack on a destroy intent", async () => {
    const c = client();
    const res = await exec(c).execute(
      intent({ action: { type: "destroy", engine: "cloudformation", requestedScopes: [] } }),
      TEMPLATE,
    );
    expect(res).toEqual({ action: "deleted", stackName: "tc-net-evo-01-reachability-dep-007" });
    expect(c.deleted[0]).toMatchObject({
      StackName: "tc-net-evo-01-reachability-dep-007",
      RoleARN: "arn:aws:iam::1:role/cfn",
    });
  });

  it("should reject unsupported action types", async () => {
    await expect(
      exec(client()).execute(
        intent({ action: { type: "inspect", engine: "cloudformation", requestedScopes: [] } }),
        TEMPLATE,
      ),
    ).rejects.toThrow(/supports deploy\/destroy/);
  });

  it("should rethrow a createStack error that is not AlreadyExists", async () => {
    const c = client({
      createStack: async () => {
        throw new NamedError("AccessDenied");
      },
    });
    await expect(exec(c).execute(intent(), TEMPLATE)).rejects.toThrow(/AccessDenied/);
  });

  it("should rethrow an updateStack error that is not 'No updates'", async () => {
    const c = client({
      createStack: async () => {
        throw new NamedError("AlreadyExistsException");
      },
      updateStack: async () => {
        throw new NamedError("ValidationError", "Template format error");
      },
    });
    await expect(exec(c).execute(intent(), TEMPLATE)).rejects.toThrow(/Template format error/);
  });

  it("should omit capabilities override and role when not configured", async () => {
    const c = client();
    const res = await exec(c, {}).execute(intent(), TEMPLATE);
    expect(res.action).toBe("created");
    expect(c.created[0].RoleARN).toBeUndefined();
    expect(c.created[0].Capabilities).toEqual(["CAPABILITY_NAMED_IAM"]);
  });

  it("should handle a create response without a StackId", async () => {
    const c = client({ createStack: async () => ({}) });
    const res = await exec(c).execute(intent(), TEMPLATE);
    expect(res).toEqual({ action: "created", stackName: "tc-net-evo-01-reachability-dep-007" });
  });

  it("should handle an update response without a StackId", async () => {
    const c = client({
      createStack: async () => {
        throw new NamedError("AlreadyExistsException");
      },
      updateStack: async () => ({}),
    });
    const res = await exec(c).execute(intent(), TEMPLATE);
    expect(res).toEqual({ action: "updated", stackName: "tc-net-evo-01-reachability-dep-007" });
  });

  it("should delete without a RoleARN when no service role is configured", async () => {
    const c = client();
    const res = await exec(c, {}).execute(
      intent({ action: { type: "destroy", engine: "cloudformation", requestedScopes: [] } }),
      TEMPLATE,
    );
    expect(res.action).toBe("deleted");
    expect(c.deleted[0].RoleARN).toBeUndefined();
  });

  it("should rethrow an update error object that carries no message", async () => {
    const c = client({
      createStack: async () => {
        throw new NamedError("AlreadyExistsException");
      },
      updateStack: async () => {
        // message-less error (= not the 'No updates' case) → rethrow.
        throw { name: "ValidationError" };
      },
    });
    await expect(exec(c).execute(intent(), TEMPLATE)).rejects.toMatchObject({
      name: "ValidationError",
    });
  });
});

function exec(
  c: CfnDeployClient,
  opts: Partial<{ executionRoleArn: string }> = { executionRoleArn: "arn:aws:iam::1:role/cfn" },
): CloudFormationExecutor {
  return new CloudFormationExecutor({ client: c, ...opts });
}
