import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploySharedResources } from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import {
  getDeployment,
  listDeployments,
  toSummary,
} from "../../lib/problem-deploy/handlers/deploy-handler/list";

function buildShared(): {
  shared: DeploySharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: DeploySharedResources = {
    tableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    env: "development",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as DeploySharedResources["ddb"],
    events: {} as unknown as DeploySharedResources["events"],
    problemsCatalog: {},
  };
  return { shared, ddbSend };
}

const sampleRow = (over: Record<string, unknown> = {}) => ({
  PK: "DEPLOYMENT#01HABC",
  SK: "META",
  GSI1PK: "TENANT#tenant-acme",
  GSI1SK: "2026-05-04T15:00:00.000Z",
  jobId: "01HABC",
  problemId: "security-battle-royale",
  tenantId: "tenant-acme",
  awsAccountId: "999999999999",
  region: "ap-northeast-1",
  teamName: "Alpha",
  namePrefix: "tc-security-battle-royale-alpha",
  teamLoginKey: "SECRET_LOGIN_KEY_DO_NOT_LEAK",
  status: "IN_PROGRESS",
  createdAt: "2026-05-04T15:00:00.000Z",
  updatedAt: "2026-05-04T15:00:01.000Z",
  expiresAt: 1_700_000_000,
  stackId: "arn:aws:cloudformation:ap-northeast-1:999999999999:stack/x/uuid",
  ...over,
});

describe("toSummary", () => {
  it("teamLoginKey を含めてはいけない", () => {
    const s = toSummary(sampleRow()) as Record<string, unknown>;
    expect(s.teamLoginKey).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain("SECRET_LOGIN_KEY_DO_NOT_LEAK");
  });

  it("公開フィールドはそのまま入るべき", () => {
    const s = toSummary(sampleRow());
    expect(s.jobId).toBe("01HABC");
    expect(s.problemId).toBe("security-battle-royale");
    expect(s.tenantId).toBe("tenant-acme");
    expect(s.status).toBe("IN_PROGRESS");
    expect(s.stackId).toContain("cloudformation");
  });
});

describe("listDeployments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GSI1 に対して TENANT#<id> で Query を投げるべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()], LastEvaluatedKey: undefined });

    await listDeployments(shared, { tenantId: "tenant-acme" });

    expect(ddbSend).toHaveBeenCalledOnce();
    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd).toBeInstanceOf(QueryCommand);
    expect(cmd.input.IndexName).toBe("GSI1");
    expect(cmd.input.KeyConditionExpression).toContain("GSI1PK = :pk");
    expect(cmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");
    expect(cmd.input.ScanIndexForward).toBe(false);
  });

  it("teamLoginKey を返り値に出さないべき (DDB の row には含まれていても)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()], LastEvaluatedKey: undefined });

    const out = await listDeployments(shared, { tenantId: "tenant-acme" });
    expect(out.items).toHaveLength(1);
    expect(JSON.stringify(out.items[0])).not.toContain("SECRET_LOGIN_KEY_DO_NOT_LEAK");
  });

  it("problemId が指定されたら filter するべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({ problemId: "security-battle-royale", jobId: "JOB1" }),
        sampleRow({ problemId: "other-problem", jobId: "JOB2" }),
      ],
      LastEvaluatedKey: undefined,
    });

    const out = await listDeployments(shared, {
      tenantId: "tenant-acme",
      problemId: "security-battle-royale",
    });
    expect(out.items.map((i) => i.jobId)).toEqual(["JOB1"]);
  });

  it("LastEvaluatedKey を base64url cursor で返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    const lastKey = { PK: "DEPLOYMENT#X", SK: "META" };
    ddbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lastKey });

    const out = await listDeployments(shared, { tenantId: "tenant-acme" });
    expect(out.nextCursor).toBeDefined();
    const decoded = JSON.parse(Buffer.from(out.nextCursor ?? "", "base64url").toString("utf8"));
    expect(decoded).toEqual(lastKey);
  });

  it("cursor を渡すと ExclusiveStartKey として渡されるべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    const startKey = { PK: "DEPLOYMENT#Y", SK: "META" };
    const cursor = Buffer.from(JSON.stringify(startKey), "utf8").toString("base64url");

    await listDeployments(shared, { tenantId: "tenant-acme", cursor });

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.ExclusiveStartKey).toEqual(startKey);
  });

  it("不正な cursor は無視して最初から開始するべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

    await listDeployments(shared, { tenantId: "tenant-acme", cursor: "!!!not-valid!!!" });

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.ExclusiveStartKey).toBeUndefined();
  });

  it("Issue #862: cursor が allowlist 外の key を含むなら無視するべき (= injection 防御)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    // 攻撃者が任意 key/value を送る試行
    const evilKey = { PK: "DEPLOYMENT#X", SK: "META", evilAttribute: "exfil" };
    const cursor = Buffer.from(JSON.stringify(evilKey), "utf8").toString("base64url");

    await listDeployments(shared, { tenantId: "tenant-acme", cursor });

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    // evilAttribute が混入したので cursor 全体を reject、 ExclusiveStartKey 無し
    expect(cmd.input.ExclusiveStartKey).toBeUndefined();
  });

  it("Issue #862: cursor が長すぎたら無視するべき (= DoS 防御)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    const cursor = "a".repeat(1024); // 512 上限超え

    await listDeployments(shared, { tenantId: "tenant-acme", cursor });

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.ExclusiveStartKey).toBeUndefined();
  });

  it("Issue #862: cursor の value が string でなければ reject", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    // 数値 / オブジェクトをキー値に詰めようとする試行
    const evilKey = { PK: { $type: "S", value: "evil" } };
    const cursor = Buffer.from(JSON.stringify(evilKey), "utf8").toString("base64url");

    await listDeployments(shared, { tenantId: "tenant-acme", cursor });

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.ExclusiveStartKey).toBeUndefined();
  });

  it("limit は 1〜200 にクランプされるべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });

    await listDeployments(shared, { tenantId: "tenant-acme", limit: 500 });
    expect((ddbSend.mock.calls[0]?.[0] as QueryCommand).input.Limit).toBe(200);

    ddbSend.mockClear();
    await listDeployments(shared, { tenantId: "tenant-acme", limit: 0 });
    expect((ddbSend.mock.calls[0]?.[0] as QueryCommand).input.Limit).toBe(1);
  });
});

describe("getDeployment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("PK=DEPLOYMENT#<jobId> SK=META で GetItem を投げるべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });

    await getDeployment(shared, "tenant-acme", "01HABC");

    const cmd = ddbSend.mock.calls[0]?.[0] as GetCommand;
    expect(cmd).toBeInstanceOf(GetCommand);
    expect(cmd.input.Key).toEqual({ PK: "DEPLOYMENT#01HABC", SK: "META" });
  });

  it("行が無ければ undefined を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });

    const out = await getDeployment(shared, "tenant-acme", "01HABC");
    expect(out).toBeUndefined();
  });

  it("tenantId が一致しない行はクロステナント漏洩防止で undefined を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow({ tenantId: "tenant-other" }) });

    const out = await getDeployment(shared, "tenant-acme", "01HABC");
    expect(out).toBeUndefined();
  });

  it("operator には teamLoginKey を含めて返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });

    const out = await getDeployment(shared, "tenant-acme", "01HABC");
    expect(out).toBeDefined();
    expect(out?.teamLoginKey).toBe("SECRET_LOGIN_KEY_DO_NOT_LEAK");
  });

  it("一覧では teamLoginKey を含めないべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    const out = await listDeployments(shared, { tenantId: "tenant-acme" });
    expect(out.items).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain("SECRET_LOGIN_KEY_DO_NOT_LEAK");
    expect((out.items[0] as { teamLoginKey?: string }).teamLoginKey).toBeUndefined();
  });
});
