import {
  type CloudFormationClient,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
} from "@aws-sdk/client-cloudformation";
import type { GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCfnConsoleUrl,
  getDeploymentForTenant,
  getStackProgressForTenant,
} from "../../lib/admin-insight/handlers/admin-insight-handler/deployments";

function buildShared(send: ReturnType<typeof vi.fn>) {
  return {
    deploymentsTableName: "TestDeployments",
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    ddb: { send } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient,
  };
}

describe("getDeploymentForTenant (ADR-011 / #598 Phase 1.B)", () => {
  beforeEach(() => vi.clearAllMocks());

  const baseItem = {
    PK: "DEPLOYMENT#01HZ",
    SK: "META",
    jobId: "01HZ",
    problemId: "p1",
    tenantId: "t1",
    awsAccountId: "123456789012",
    region: "ap-northeast-1",
    teamName: "team-alpha",
    namePrefix: "team-alpha-p1",
    status: "COMPLETE",
    createdAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T01:00:00.000Z",
    expiresAt: 0,
    teamLoginKey: "SECRET-DO-NOT-LEAK",
  };

  it("DDB に行が無ければ undefined を返すべき (= 404 相当)", async () => {
    const send = vi.fn().mockResolvedValue({ Item: undefined });
    const result = await getDeploymentForTenant(buildShared(send), "t1", "01HZ");
    expect(result).toBeUndefined();
  });

  it("tenantId 不一致なら undefined を返すべき (= cross-tenant 漏洩防止)", async () => {
    const send = vi.fn().mockResolvedValue({ Item: { ...baseItem, tenantId: "OTHER" } });
    const result = await getDeploymentForTenant(buildShared(send), "t1", "01HZ");
    expect(result).toBeUndefined();
  });

  it("teamLoginKey は response に乗らないべき (security regression pin)", async () => {
    const send = vi.fn().mockResolvedValue({ Item: baseItem });
    const result = await getDeploymentForTenant(buildShared(send), "t1", "01HZ");
    expect(result?.teamLoginKey).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("SECRET-DO-NOT-LEAK");
  });

  it("DDB の Get で正しい PK / SK を引くべき", async () => {
    const send = vi.fn().mockResolvedValue({ Item: baseItem });
    await getDeploymentForTenant(buildShared(send), "t1", "01HZ");
    const cmd = send.mock.calls[0][0] as GetCommand;
    expect(cmd.input.TableName).toBe("TestDeployments");
    expect(cmd.input.Key).toEqual({ PK: "DEPLOYMENT#01HZ", SK: "META" });
  });

  it("成功時は jobId / problemId / status / stackId 等を返すべき (mirror shape)", async () => {
    const send = vi.fn().mockResolvedValue({
      Item: { ...baseItem, stackId: "arn:cfn:stack/abc", failureReason: undefined },
    });
    const result = await getDeploymentForTenant(buildShared(send), "t1", "01HZ");
    expect(result).toMatchObject({
      jobId: "01HZ",
      problemId: "p1",
      tenantId: "t1",
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
      teamName: "team-alpha",
      namePrefix: "team-alpha-p1",
      status: "COMPLETE",
      stackId: "arn:cfn:stack/abc",
    });
  });
});

describe("getStackProgressForTenant (ADR-011 / #598 Phase 1.B)", () => {
  beforeEach(() => vi.clearAllMocks());

  const baseItem = {
    PK: "DEPLOYMENT#01HZ",
    SK: "META",
    jobId: "01HZ",
    tenantId: "t1",
    namePrefix: "team-alpha-p1",
    region: "ap-northeast-1",
    stackId: "arn:aws:cloudformation:ap-northeast-1:111:stack/team-alpha-p1/abc",
  };

  function buildCfnFactory(stub: Partial<CloudFormationClient>): {
    cfnClient: (region: string) => CloudFormationClient;
  } {
    return {
      cfnClient: () => stub as unknown as CloudFormationClient,
    };
  }

  it("行不在なら kind=not_found を返すべき", async () => {
    const send = vi.fn().mockResolvedValue({ Item: undefined });
    const cfnSend = vi.fn();
    const outcome = await getStackProgressForTenant(
      buildShared(send),
      buildCfnFactory({ send: cfnSend as unknown as CloudFormationClient["send"] }),
      "t1",
      "01HZ",
    );
    expect(outcome.kind).toBe("not_found");
    expect(cfnSend).not.toHaveBeenCalled();
  });

  it("tenantId 不一致なら kind=not_found を返すべき", async () => {
    const send = vi.fn().mockResolvedValue({ Item: { ...baseItem, tenantId: "OTHER" } });
    const outcome = await getStackProgressForTenant(
      buildShared(send),
      buildCfnFactory({ send: vi.fn() as unknown as CloudFormationClient["send"] }),
      "t1",
      "01HZ",
    );
    expect(outcome.kind).toBe("not_found");
  });

  it("namePrefix / region 未割当なら kind=stack_not_yet_created を返すべき", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ Item: { ...baseItem, namePrefix: undefined, region: undefined } });
    const outcome = await getStackProgressForTenant(
      buildShared(send),
      buildCfnFactory({ send: vi.fn() as unknown as CloudFormationClient["send"] }),
      "t1",
      "01HZ",
    );
    expect(outcome.kind).toBe("stack_not_yet_created");
  });

  it("CFn DescribeStackEvents / DescribeStackResources を並列発行するべき", async () => {
    const send = vi.fn().mockResolvedValue({ Item: baseItem });
    const cfnSend = vi.fn().mockImplementation(async (cmd) => {
      if (cmd instanceof DescribeStackEventsCommand) {
        return {
          StackEvents: [
            {
              Timestamp: new Date("2026-05-11T00:00:00Z"),
              LogicalResourceId: "team-alpha-p1",
              ResourceType: "AWS::CloudFormation::Stack",
              ResourceStatus: "CREATE_COMPLETE",
            },
          ],
        };
      }
      if (cmd instanceof DescribeStackResourcesCommand) {
        return {
          StackResources: [
            {
              LogicalResourceId: "MyBucket",
              ResourceType: "AWS::S3::Bucket",
              ResourceStatus: "CREATE_COMPLETE",
            },
          ],
        };
      }
      throw new Error(`unexpected cmd: ${cmd.constructor.name}`);
    });
    const outcome = await getStackProgressForTenant(
      buildShared(send),
      buildCfnFactory({ send: cfnSend as unknown as CloudFormationClient["send"] }),
      "t1",
      "01HZ",
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.progress.events).toHaveLength(1);
    expect(outcome.progress.resources).toHaveLength(1);
    expect(outcome.progress.stackStatus).toBe("CREATE_COMPLETE");
    expect(outcome.progress.consoleUrl).toContain("ap-northeast-1");
    expect(cfnSend).toHaveBeenCalledTimes(2);
  });

  it("CFn が 'does not exist' を投げたら kind=stack_not_found_in_cfn を返すべき", async () => {
    const send = vi.fn().mockResolvedValue({ Item: baseItem });
    const cfnSend = vi.fn().mockRejectedValue(
      Object.assign(new Error("Stack with id team-alpha-p1 does not exist"), {
        name: "ValidationError",
      }),
    );
    const outcome = await getStackProgressForTenant(
      buildShared(send),
      buildCfnFactory({ send: cfnSend as unknown as CloudFormationClient["send"] }),
      "t1",
      "01HZ",
    );
    expect(outcome.kind).toBe("stack_not_found_in_cfn");
    if (outcome.kind !== "stack_not_found_in_cfn") throw new Error("unreachable");
    expect(outcome.consoleUrl).toContain("ap-northeast-1");
  });
});

describe("buildCfnConsoleUrl", () => {
  it("stackId があれば stackinfo deep link を返すべき", () => {
    const url = buildCfnConsoleUrl("ap-northeast-1", "team-alpha-p1", "arn:cfn:stack/abc/123");
    expect(url).toContain("ap-northeast-1");
    expect(url).toContain("stackinfo?stackId=");
    expect(url).toContain(encodeURIComponent("arn:cfn:stack/abc/123"));
  });

  it("stackId が無ければ filteringText 経由の stack 一覧 URL を返すべき", () => {
    const url = buildCfnConsoleUrl("us-east-1", "stack-x");
    expect(url).toContain("filteringText=stack-x");
  });
});
