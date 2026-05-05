import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeployContext,
  type DeployInvocation,
  startDeployment,
} from "../../lib/problem-deploy/handlers/deploy-handler/deploy";

function buildContext(overrides: Partial<DeployContext> = {}): {
  ctx: DeployContext;
  ddbSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn().mockResolvedValue({});
  const eventsSend = vi.fn().mockResolvedValue({});
  const ctx: DeployContext = {
    tableName: "TestDeployments",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as DeployContext["ddb"],
    events: { send: eventsSend } as unknown as DeployContext["events"],
    now: () => 1_700_000_000_000,
    ttlMs: 60_000,
    tenantId: "tenant-acme",
    ...overrides,
  };
  return { ctx, ddbSend, eventsSend };
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
    const { ctx, ddbSend } = buildContext();
    await startDeployment(ctx, sampleRequest());
    expect(ddbSend).toHaveBeenCalledOnce();
    const cmd = ddbSend.mock.calls[0]?.[0] as PutCommand;
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
    const { ctx, ddbSend } = buildContext();
    await startDeployment(ctx, sampleRequest());
    const cmd = ddbSend.mock.calls[0]?.[0] as PutCommand;
    const item = cmd.input.Item;
    expect(typeof item?.teamLoginKey).toBe("string");
    expect(item?.GSI2PK).toBe(`TEAMKEY#${item?.teamLoginKey}`);
    expect(item?.GSI2SK).toBe(item?.GSI1SK);
  });

  it("EventBridge に DeployRequested イベントを送るべき", async () => {
    const { ctx, eventsSend } = buildContext();
    await startDeployment(ctx, sampleRequest());
    expect(eventsSend).toHaveBeenCalledOnce();
    const cmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(cmd).toBeInstanceOf(PutEventsCommand);
    const entry = cmd.input.Entries?.[0];
    expect(entry?.EventBusName).toBe("test-bus");
    expect(entry?.Source).toBe("tenkacloud.problem");
    expect(entry?.DetailType).toBe("DeployRequested");
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
    const { ctx, eventsSend } = buildContext();
    (ctx.ddb.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("DDB down"));
    await expect(startDeployment(ctx, sampleRequest())).rejects.toThrow("DDB down");
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("forward-compat フィールド (accountGroupId / problemSetId) も保存するべき", async () => {
    const { ctx, ddbSend } = buildContext();
    await startDeployment(ctx, sampleRequest({ accountGroupId: "group-1", problemSetId: "set-1" }));
    const cmd = ddbSend.mock.calls[0]?.[0] as PutCommand;
    expect(cmd.input.Item?.accountGroupId).toBe("group-1");
    expect(cmd.input.Item?.problemSetId).toBe("set-1");
  });

  it("default TTL は 8 時間 (秒単位)", async () => {
    const fixedNow = 1_700_000_000_000;
    const { ctx, ddbSend } = buildContext({ ttlMs: undefined, now: () => fixedNow });
    await startDeployment(ctx, sampleRequest());
    const cmd = ddbSend.mock.calls[0]?.[0] as PutCommand;
    expect(cmd.input.Item?.expiresAt).toBe(Math.floor((fixedNow + 8 * 60 * 60 * 1000) / 1000));
  });
});
