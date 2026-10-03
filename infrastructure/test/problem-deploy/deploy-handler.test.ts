import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeployContext,
  type DeployInvocation,
  startDeployment,
  UnknownProblemError,
  UnverifiedCompetitorAccountError,
} from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

// Issue #642: presigned URL 発行は AWS SDK の signing が必要なので
// 実 SDK を呼ばずに deterministic な URL を返すよう module を mock する。
// generateChallengePayloadUrl の input 検証はこの mock で十分。
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/presigned-url", () => ({
  generateChallengePayloadUrl: vi.fn(
    async (args: { bucketName: string; problemId: string; expiresInSeconds?: number }) =>
      `https://${args.bucketName}.s3.ap-northeast-1.amazonaws.com/${args.problemId}/latest.zip?X-Amz-Signature=fake-${args.expiresInSeconds ?? 900}`,
  ),
}));

/**
 * Phase 2.2 (Issue #459): startDeployment が事前に CompetitorAccounts table を Get
 * (verified=true gate) するようになった。test では default で「verified=true」を返し、
 * `unverified=true` option で「verified=false」を pin する。
 */
function buildContext(
  overrides: Partial<DeployContext> = {},
  options: { unverified?: boolean; quotaActiveCount?: number } = {},
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
    // #1766: quota の active-count Query (Select: COUNT)。
    if (cmd instanceof QueryCommand && cmd.input.Select === "COUNT") {
      return { Count: options.quotaActiveCount ?? 0 };
    }
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
    runtime: makeTestControlDataRuntime(),
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

  it("should send a single PutItem to DDB", async () => {
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
    expect(item?.competitorRoleArn).toBe(
      "arn:aws:iam::123456789012:role/TenkaCloud-CompetitorDeploy-Role",
    );
  });

  it("should write GSI2PK = TEAMKEY#<teamLoginKey> for the sparse index", async () => {
    const { ctx, putSend } = buildContext();
    await startDeployment(ctx, sampleRequest());
    const cmd = putSend.mock.calls[0]?.[0] as PutCommand;
    const item = cmd.input.Item;
    expect(typeof item?.teamLoginKey).toBe("string");
    expect(item?.GSI2PK).toBe(`TEAMKEY#${item?.teamLoginKey}`);
    expect(item?.GSI2SK).toBe(item?.GSI1SK);
  });

  it("should send a DeployCreateRequested event to EventBridge", async () => {
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

  it("should return jobId / status / namePrefix / teamLoginKey / expiresAt in the response", async () => {
    const { ctx } = buildContext();
    const res = await startDeployment(ctx, sampleRequest());
    expect(res.jobId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    expect(res.status).toBe("PENDING");
    expect(res.namePrefix).toBe("tc-security-battle-royale-alpha-team");
    expect(res.teamLoginKey).toMatch(/^[A-Za-z0-9_-]{40,}$/); // base64url 32 byte
    expect(res.expiresAt).toBe(Math.floor((1_700_000_000_000 + 60_000) / 1000));
  });

  it("generated jobIds should differ on each call", async () => {
    const { ctx } = buildContext();
    const a = await startDeployment(ctx, sampleRequest());
    const b = await startDeployment(ctx, sampleRequest());
    expect(a.jobId).not.toBe(b.jobId);
    expect(a.teamLoginKey).not.toBe(b.teamLoginKey);
  });

  it("should throw without calling EventBridge when DDB Put fails", async () => {
    const { ctx, putSend, eventsSend } = buildContext();
    putSend.mockRejectedValueOnce(new Error("DDB down"));
    await expect(startDeployment(ctx, sampleRequest())).rejects.toThrow("DDB down");
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should compensate by updating the deployment to FAILED when EventBridge publish fails", async () => {
    const { ctx, putSend, eventsSend } = buildContext();
    eventsSend.mockResolvedValueOnce({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: "InternalFailure", ErrorMessage: "event bus down" }],
    });

    await expect(startDeployment(ctx, sampleRequest())).rejects.toThrow(/EventBridge PutEvents/);

    const putCmd = putSend.mock.calls[0]?.[0] as PutCommand;
    const updateCmd = putSend.mock.calls
      .map((c) => c[0])
      .find((c): c is UpdateCommand => c instanceof UpdateCommand);
    expect(updateCmd).toBeInstanceOf(UpdateCommand);
    expect(updateCmd?.input.Key).toEqual(
      putCmd.input.Item ? { PK: putCmd.input.Item.PK, SK: "META" } : undefined,
    );
    expect(updateCmd?.input.UpdateExpression).toContain("#s = :failed");
    // #872: compensation 経路でも tenantId と #s の両方を condition で AND。
    expect(updateCmd?.input.ConditionExpression).toBe("tenantId = :tenantId AND #s = :pending");
    expect(updateCmd?.input.ExpressionAttributeValues?.[":failed"]).toBe("FAILED");
    expect(updateCmd?.input.ExpressionAttributeValues?.[":reason"]).toBe(
      "Failed to publish DeployCreateRequested event",
    );
    expect(updateCmd?.input.ExpressionAttributeValues?.[":tenantId"]).toBeDefined();
  });

  it("should also persist forward-compat fields (accountGroupId / problemSetId)", async () => {
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
  it("should reject awsAccountId without a verified=true CompetitorAccounts row (throw Unverified…)", async () => {
    const { ctx, putSend, eventsSend } = buildContext({}, { unverified: true });
    await expect(startDeployment(ctx, sampleRequest())).rejects.toBeInstanceOf(
      UnverifiedCompetitorAccountError,
    );
    expect(putSend).not.toHaveBeenCalled();
    expect(eventsSend).not.toHaveBeenCalled();
  });

  // Phase 2.2: DeployCreateRequested detail に competitorRoleArn / externalIdParameterName を含めるべき
  it("should pack competitorRoleArn / externalIdParameterName for AssumeRole into DeployCreateRequested detail", async () => {
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

  // Issue #642: visibility / bucket env が dormant なら presigned URL を発行しない (= default)
  describe("Issue #642: private 問題の presigned URL 発行", () => {
    it("visibility 空のとき detail.challengePayloadUrl は undefined (= default 互換)", async () => {
      const { ctx, eventsSend } = buildContext();
      await startDeployment(ctx, sampleRequest());
      const cmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
      const entry = cmd.input.Entries?.[0];
      const detail = JSON.parse(entry?.Detail ?? "{}");
      expect(detail.challengePayloadUrl).toBeUndefined();
    });

    it("bucket 未設定のとき private 問題でも presigned URL を発行しない (= dormant)", async () => {
      const { ctx, eventsSend } = buildContext({
        problemsVisibility: { "security-battle-royale": "private" },
        // challengePayloadBucket は undefined のまま
      });
      await startDeployment(ctx, sampleRequest());
      const cmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
      const detail = JSON.parse(cmd.input.Entries?.[0]?.Detail ?? "{}");
      expect(detail.challengePayloadUrl).toBeUndefined();
    });

    it("should pack a presigned URL into detail when a private problem has a bucket configured and an S3 client", async () => {
      const { ctx, eventsSend } = buildContext({
        problemsVisibility: { "security-battle-royale": "private" },
        challengePayloadBucket: "tc-challenges-test",
        s3: {} as DeployContext["s3"],
      });
      await startDeployment(ctx, sampleRequest());
      const cmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
      const detail = JSON.parse(cmd.input.Entries?.[0]?.Detail ?? "{}");
      expect(typeof detail.challengePayloadUrl).toBe("string");
      expect(detail.challengePayloadUrl).toContain("tc-challenges-test");
      expect(detail.challengePayloadUrl).toContain("security-battle-royale/latest.zip");
    });

    it("public 問題は private map に無いので bucket 設定があっても presigned URL を発行しない", async () => {
      const { ctx, eventsSend } = buildContext({
        problemsVisibility: { "some-other-private-problem": "private" },
        challengePayloadBucket: "tc-challenges-test",
        s3: {} as DeployContext["s3"],
      });
      await startDeployment(ctx, sampleRequest({ problemId: "security-battle-royale" }));
      const cmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
      const detail = JSON.parse(cmd.input.Entries?.[0]?.Detail ?? "{}");
      expect(detail.challengePayloadUrl).toBeUndefined();
    });

    it("should throw an error for private problems with a bucket but no s3 client injected", async () => {
      const { ctx } = buildContext({
        problemsVisibility: { "security-battle-royale": "private" },
        challengePayloadBucket: "tc-challenges-test",
        s3: undefined,
      });
      await expect(startDeployment(ctx, sampleRequest())).rejects.toThrow(/S3 client/);
    });
  });
});

/**
 * #1766 + PR-1803 review: クォータは「より具体的な検証の後・mutation の直前」に enforce する。
 * 上限到達中でも unknown problem / unverified account はそれぞれ本来のエラーで返り、
 * 429 がそれらを隠さないことを pin する。
 */
describe("startDeployment quota ordering (#1766)", () => {
  const QUOTA = { basic: 1, advanced: 5, platinum: 10 };

  it("should throw UnknownProblemError (not quota) for an unknown problem even at capacity", async () => {
    const { ctx } = buildContext({ deployQuota: QUOTA }, { quotaActiveCount: 99 });
    await expect(
      startDeployment(ctx, sampleRequest({ problemId: "nope", quotaTier: "basic" })),
    ).rejects.toBeInstanceOf(UnknownProblemError);
  });

  it("should throw UnverifiedCompetitorAccountError (not quota) even at capacity", async () => {
    const { ctx } = buildContext(
      { deployQuota: QUOTA },
      { unverified: true, quotaActiveCount: 99 },
    );
    await expect(
      startDeployment(ctx, sampleRequest({ quotaTier: "basic" })),
    ).rejects.toBeInstanceOf(UnverifiedCompetitorAccountError);
  });

  it("should throw DeployQuotaExceededError before any DDB Put when at capacity", async () => {
    const { ctx, putSend } = buildContext({ deployQuota: QUOTA }, { quotaActiveCount: 1 });
    await expect(startDeployment(ctx, sampleRequest({ quotaTier: "basic" }))).rejects.toMatchObject(
      { name: "DeployQuotaExceededError", tier: "basic", limit: 1 },
    );
    // Put / publish (= cloud mutation) に到達しない。
    expect(putSend).not.toHaveBeenCalled();
  });

  it("should proceed normally under the limit and when quota is disabled", async () => {
    const under = buildContext({ deployQuota: QUOTA }, { quotaActiveCount: 0 });
    await expect(
      startDeployment(under.ctx, sampleRequest({ quotaTier: "basic" })),
    ).resolves.toMatchObject({ status: "PENDING" });
    const disabled = buildContext({}, { quotaActiveCount: 99 });
    await expect(startDeployment(disabled.ctx, sampleRequest())).resolves.toMatchObject({
      status: "PENDING",
    });
  });
});
