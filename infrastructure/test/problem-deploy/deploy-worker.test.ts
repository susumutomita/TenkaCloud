import type { CreateStackCommand } from "@aws-sdk/client-cloudformation";
import type { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import type { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AssumedCredentials,
  handleDeployRequested,
  type WorkerSharedResources,
} from "../../lib/problem-deploy/handlers/deploy-worker/worker";

const FIXED_CREDS: AssumedCredentials = {
  accessKeyId: "AKIA-TEST",
  secretAccessKey: "secret",
  sessionToken: "token",
};

function buildShared(overrides: Partial<WorkerSharedResources> = {}): {
  shared: WorkerSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
  stsSend: ReturnType<typeof vi.fn>;
  cfnSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn().mockResolvedValue({});
  const eventsSend = vi.fn().mockResolvedValue({});
  const stsSend = vi.fn().mockResolvedValue({
    Credentials: {
      AccessKeyId: FIXED_CREDS.accessKeyId,
      SecretAccessKey: FIXED_CREDS.secretAccessKey,
      SessionToken: FIXED_CREDS.sessionToken,
    },
  });
  const cfnSend = vi.fn().mockResolvedValue({ StackId: "arn:aws:cloudformation:.../stk-1/uuid" });
  const shared: WorkerSharedResources = {
    tableName: "TestDeployments",
    eventBusName: "test-bus",
    competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
    externalId: "ext-id-test",
    ddb: { send: ddbSend } as unknown as WorkerSharedResources["ddb"],
    events: { send: eventsSend } as unknown as WorkerSharedResources["events"],
    sts: { send: stsSend } as unknown as WorkerSharedResources["sts"],
    cfnFactory: () =>
      ({ send: cfnSend }) as unknown as ReturnType<WorkerSharedResources["cfnFactory"]>,
    readTemplate: () => "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n",
    secretFactory: () => "fixed-secret-1234567890ab",
    ...overrides,
  };
  return { shared, ddbSend, eventsSend, stsSend, cfnSend };
}

const sampleDetail = () => ({
  jobId: "01HABCXYZ",
  problemId: "security-battle-royale",
  tenantId: "tenant-acme",
  awsAccountId: "999999999999",
  region: "ap-northeast-1",
  teamName: "Alpha Team",
  namePrefix: "tc-security-battle-royale-alpha-team",
});

describe("handleDeployRequested", () => {
  beforeEach(() => vi.clearAllMocks());

  it("AssumeRole / CreateStack / DDB Update / DeployStarted の順で処理するべき", async () => {
    const { shared, stsSend, cfnSend, ddbSend, eventsSend } = buildShared();
    await handleDeployRequested(shared, sampleDetail());

    expect(stsSend).toHaveBeenCalledOnce();
    const stsCmd = stsSend.mock.calls[0]?.[0] as AssumeRoleCommand;
    expect(stsCmd.input.RoleArn).toBe(
      "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
    );
    expect(stsCmd.input.ExternalId).toBe("ext-id-test");

    expect(cfnSend).toHaveBeenCalledOnce();
    const cfnCmd = cfnSend.mock.calls[0]?.[0] as CreateStackCommand;
    expect(cfnCmd.input.StackName).toBe("tc-security-battle-royale-alpha-team");
    expect(cfnCmd.input.Parameters).toEqual(
      expect.arrayContaining([
        { ParameterKey: "NamePrefix", ParameterValue: "tc-security-battle-royale-alpha-team" },
        { ParameterKey: "DbPassword", ParameterValue: "fixed-secret-1234567890ab" },
        { ParameterKey: "AllowedCidr", ParameterValue: "0.0.0.0/0" },
      ]),
    );

    expect(ddbSend).toHaveBeenCalledOnce();
    const updateCmd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    expect(updateCmd.input.ExpressionAttributeValues?.[":status"]).toBe("IN_PROGRESS");
    expect(updateCmd.input.ExpressionAttributeValues?.[":stackId"]).toBe(
      "arn:aws:cloudformation:.../stk-1/uuid",
    );

    expect(eventsSend).toHaveBeenCalledOnce();
    const evtCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(evtCmd.input.Entries?.[0].DetailType).toBe("DeployStarted");
  });

  it("AssumeRole 失敗時は FAILED に更新して throw するべき", async () => {
    const { shared, stsSend, cfnSend, ddbSend, eventsSend } = buildShared();
    stsSend.mockRejectedValueOnce(new Error("AccessDenied"));
    await expect(handleDeployRequested(shared, sampleDetail())).rejects.toThrow("AccessDenied");
    expect(cfnSend).not.toHaveBeenCalled();
    // markFailed が DDB と EventBridge を呼ぶ
    expect(ddbSend).toHaveBeenCalledOnce();
    const updateCmd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    expect(updateCmd.input.ExpressionAttributeValues?.[":status"]).toBe("FAILED");
    expect(eventsSend).toHaveBeenCalledOnce();
    expect((eventsSend.mock.calls[0]?.[0] as PutEventsCommand).input.Entries?.[0].DetailType).toBe(
      "DeployFailed",
    );
  });

  it("CreateStack 失敗時も FAILED に更新して throw するべき", async () => {
    const { shared, cfnSend, ddbSend, eventsSend } = buildShared();
    cfnSend.mockRejectedValueOnce(new Error("ValidationError"));
    await expect(handleDeployRequested(shared, sampleDetail())).rejects.toThrow("ValidationError");
    expect(ddbSend).toHaveBeenCalledOnce();
    const updateCmd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    expect(updateCmd.input.ExpressionAttributeValues?.[":status"]).toBe("FAILED");
    expect(eventsSend).toHaveBeenCalledOnce();
  });

  it("CreateStack が StackId を返さなかったら失敗扱いにすべき", async () => {
    const { shared, cfnSend } = buildShared();
    cfnSend.mockResolvedValueOnce({});
    await expect(handleDeployRequested(shared, sampleDetail())).rejects.toThrow();
  });

  it("AssumeRole が Credentials を返さなかったら失敗扱いにすべき", async () => {
    const { shared, stsSend } = buildShared();
    stsSend.mockResolvedValueOnce({ Credentials: null });
    await expect(handleDeployRequested(shared, sampleDetail())).rejects.toThrow();
  });
});
