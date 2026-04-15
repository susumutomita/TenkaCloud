import { describe, it, expect, vi } from "vitest";
import { deployProblem, type DeployProblemInput } from "../../lib/handlers/deploy-problem";

describe("deployProblem", () => {
  const baseInput: DeployProblemInput = {
    problemId: "prob-001",
    teamId: "team-abc",
    tenantId: "tenant-123",
    targetRoleArn: "arn:aws:iam::999999999999:role/deploy-role",
    externalId: "ext-id-123",
    templateUrl: "https://s3.amazonaws.com/bucket/template.yaml",
    appName: "TenkaCloud",
  };

  it("should skip deployment when templateUrl is not set", async () => {
    const input = { ...baseInput, templateUrl: undefined };
    const result = await deployProblem(input);

    expect(result.deployStatus).toBe("completed");
  });

  it("should throw when AssumeRole returns no credentials", async () => {
    const mockStsSend = vi.fn().mockResolvedValue({ Credentials: undefined });
    const mockStsClient = { send: mockStsSend } as any;

    await expect(deployProblem(baseInput, mockStsClient)).rejects.toThrow("AssumeRole returned no credentials");
  });

  it("should call AssumeRole with ExternalId for Confused Deputy protection", async () => {
    const mockStsSend = vi.fn().mockResolvedValue({
      Credentials: {
        AccessKeyId: "AKIA...",
        SecretAccessKey: "secret",
        SessionToken: "token",
      },
    });
    const mockStsClient = { send: mockStsSend } as any;

    // Will fail on CreateStack since we can't easily mock the CFN client created internally,
    // but we can verify AssumeRole was called correctly
    try {
      await deployProblem(baseInput, mockStsClient);
    } catch {
      // Expected: CreateStack will fail without a real CFN client
    }

    expect(mockStsSend).toHaveBeenCalledOnce();
    const cmd = mockStsSend.mock.calls[0][0];
    expect(cmd.input.RoleArn).toBe(baseInput.targetRoleArn);
    expect(cmd.input.ExternalId).toBe(baseInput.externalId);
    expect(cmd.input.RoleSessionName).toBe("problem-deploy-prob-001");
  });
});
