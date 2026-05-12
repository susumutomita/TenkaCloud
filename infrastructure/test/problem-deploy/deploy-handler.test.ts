import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeployContext,
  type DeployInvocation,
  startDeployment,
  UnverifiedCompetitorAccountError,
} from "../../lib/problem-deploy/handlers/deploy-handler/deploy";

/**
 * Phase 2.2 (Issue #459): startDeployment が事前に CompetitorAccounts table を Get
 * (verified=true gate) するようになった。test では default で「verified=true」を返し、
 * `unverified=true` option で「verified=false」を pin する。
 */
function buildContext(
  overrides: Partial<DeployContext> = {},
  options: { unverified?: boolean } = {},
): {
  ctx: DeployContext;
  putSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
} {
  const putSend = vi.fn().mockResolvedValue({});
  const eventsSend = vi.fn().mockResolvedValue({});
  // GetCommand (CompetitorAccounts) を verified=true / unverified=false に振り分け、
  // それ以外 (PutCommand 等) は putSend に流す。test 側 assertion は putSend の最後の
  // call を見るのが基本。
  const ddbSend = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand && cmd.input.TableName === "TestCompetitorAccounts") {
      if (options.unverified) return { Item: undefined };
      const sk = String(cmd.input.Key?.SK ?? "");
      const awsAccountId = sk.replace(/^ACCOUNT#/, "");
      return {
        Item: {
          PK: cmd.input.Key?.PK,
          SK: cmd.input.Key?.SK,
          awsAccountId,
          region: "ap-northeast-1",
          competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
          verified: true,
        },
      };
    }
    return putSend(cmd);
  });
  const ctx: DeployContext = {
    tableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    env: "development",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as DeployContext["ddb"],
    events: { send: eventsSend } as unknown as DeployContext["events"],
    now: () => 1_700_000_000_000,
    ttlMs: 60_000,
    tenantId: "tenant-acme",
    problemsCatalog: {
      "security-battle-royale": "problems/battles/security-battle-royale",
      "hello-world": "problems/challenges/hello-world",
    },
    ...overrides,
  };
  return { ctx, putSend, eventsSend };
}

const sampleRequest = (overrides: Partial<DeployInvocation> = {}): DeployInvocation => ({
  problemId: "security-battle-royale",
  region: "ap-northeast-1",
  awsAccountId: "123456789012",
  teamName: "Alpha Team",
  ...overrides,
});

describe("startDeployment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("DDB に PutItem を 1 回 送るべき", async () => {
    const { ctx, putSend } = buildContext();
    await startDeployment(ctx, sampleRequest());
    expect(putSend).toHaveBeenCalledOnce();
    const cmd = putSend.mock.calls[0]?.[0] as PutCommand;
    expect(cmd).toBeInstanceOf(PutCommand);
    const item = cmd.input.Item;
    expect(cmd.input.TableName).toBe("TestDeployments");
    expect(item?.PK).toMatch(/^DEPLOYMENT#/);
    expect(item?.SK).toBe("META");
    expect(item?.status).toBe("PENDING");
    expect(item?.GSI1PK).toBe("TENANT#tenant-acme");
    expect(typeof item?.GSI1SK).toBe("string");
    expect(item?.namePrefix).toBe("tc-security-battle-royale-alpha-team");
  });

  it("GSI2PK = TEAMKEY#<teamLoginKey> を sparse index 用に書き込むべき", async () => {
    const { ctx, putSend } = buildContext();
    await startDeployment(ctx, sampleRequest());
    const cmd = putSend.mock.calls[0]?.[0] as PutCommand;
    const item = cmd.input.Item;
    expect(typeof item?.teamLoginKey).toBe("string");
    expect(item?.GSI2PK).toBe(`TEAMKEY#${item?.teamLoginKey}`);
    expect(item?.GSI2SK).toBe(item?.GSI1SK);
  });

  it("EventBridge に DeployCreateRequested イベントを送るべき", async () => {
    const { ctx, eventsSend } = buildContext();
    await startDeployment(ctx, sampleRequest());
    expect(eventsSend).toHaveBeenCalledOnce();
    const cmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(cmd).toBeInstanceOf(PutEventsCommand);
    const entry = cmd.input.Entries?.[0];
    expect(entry?.EventBusName).toBe("test-bus");
    expect(entry?.Source).toBe("tenkacloud.deploy");
    expect(entry?.DetailType).toBe("DeployCreateRequested");
    const detail = JSON.parse(entry?.Detail ?? "{}");
    expect(detail.problemId).toBe("security-battle-royale");
    expect(detail.tenantId).toBe("tenant-acme");
    expect(detail.namePrefix).toBe("tc-security-battle-royale-alpha-team");
  });

  it("response に jobId / status / namePrefix / teamLoginKey / expiresAt を返すべき", async () => {
    const { ctx } = buildContext();
    const res = await startDeployment(ctx, sampleRequest());
    expect(res.jobId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    expect(res.status).toBe("PENDING");
    expect(res.namePrefix).toBe("tc-security-battle-royale-alpha-team");
    expect(res.teamLoginKey).toMatch(/^[A-Za-z0-9_-]{40,}$/); // base64url 32 byte
    expect(res.expiresAt).toBe(Math.floor((1_700_000_000_000 + 60_000) / 1000));
  });

  it("生成される jobId は呼び出しごとに異なるべき", async () => {
    const { ctx } = buildContext();
    const a = await startDeployment(ctx, sampleRequest());
    const b = await startDeployment(ctx, sampleRequest());
    expect(a.jobId).not.toBe(b.jobId);
    expect(a.teamLoginKey).not.toBe(b.teamLoginKey);
  });

  it("DDB Put が失敗したら EventBridge を呼ばずに throw するべき", async () => {
    const { ctx, putSend, eventsSend } = buildContext();
    putSend.mockRejectedValueOnce(new Error("DDB down"));
    await expect(startDeployment(ctx, sampleRequest())).rejects.toThrow("DDB down");
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("forward-compat フィールド (accountGroupId / problemSetId) も保存するべき", async () => {
    const { ctx, putSend } = buildContext();
    await startDeployment(ctx, sampleRequest({ accountGroupId: "group-1", problemSetId: "set-1" }));
    const cmd = putSend.mock.calls[0]?.[0] as PutCommand;
    expect(cmd.input.Item?.accountGroupId).toBe("group-1");
    expect(cmd.input.Item?.problemSetId).toBe("set-1");
  });

  it("default TTL は 8 時間 (秒単位)", async () => {
    const fixedNow = 1_700_000_000_000;
    const { ctx, putSend } = buildContext({ ttlMs: undefined, now: () => fixedNow });
    await startDeployment(ctx, sampleRequest());
    const cmd = putSend.mock.calls[0]?.[0] as PutCommand;
    expect(cmd.input.Item?.expiresAt).toBe(Math.floor((fixedNow + 8 * 60 * 60 * 1000) / 1000));
  });

  // Phase 2.2 (Issue #459): verified=true 行が無いと UnverifiedCompetitorAccountError を投げるべき
  it("CompetitorAccounts に verified=true 行が無い awsAccountId は reject (Unverified… throw) するべき", async () => {
    const { ctx, putSend, eventsSend } = buildContext({}, { unverified: true });
    await expect(startDeployment(ctx, sampleRequest())).rejects.toBeInstanceOf(
      UnverifiedCompetitorAccountError,
    );
    expect(putSend).not.toHaveBeenCalled();
    expect(eventsSend).not.toHaveBeenCalled();
  });

  // Phase 2.2: DeployCreateRequested detail に competitorRoleArn / externalIdParameterName を含めるべき
  it("DeployCreateRequested detail に AssumeRole 用 competitorRoleArn / externalIdParameterName を詰めるべき", async () => {
    const { ctx, eventsSend } = buildContext();
    await startDeployment(ctx, sampleRequest());
    const cmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    const entry = cmd.input.Entries?.[0];
    const detail = JSON.parse(entry?.Detail ?? "{}");
    expect(detail.competitorRoleArn).toBe(
      "arn:aws:iam::123456789012:role/TenkaCloud-CompetitorDeploy-Role",
    );
    expect(detail.externalIdParameterName).toBe("/development/tenants/tenant-acme/external-id");
  });
});
