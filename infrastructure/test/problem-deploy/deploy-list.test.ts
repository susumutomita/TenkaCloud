import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploySharedResources } from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import {
  getDeployment,
  listDeployments,
  toSummary,
} from "../../lib/problem-deploy/handlers/deploy-handler/list";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

function buildShared(): {
  shared: DeploySharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: DeploySharedResources = {
    runtime: makeTestControlDataRuntime(),
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

  it("public fields should be included as-is", () => {
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

  it("should issue a Query against GSI1 with TENANT#<id>", async () => {
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

  it("should not surface teamLoginKey in the return value (even if present in the DDB row)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()], LastEvaluatedKey: undefined });

    const out = await listDeployments(shared, { tenantId: "tenant-acme" });
    expect(out.items).toHaveLength(1);
    expect(JSON.stringify(out.items[0])).not.toContain("SECRET_LOGIN_KEY_DO_NOT_LEAK");
  });

  it("should filter when problemId is specified", async () => {
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

  it("should return LastEvaluatedKey as a base64url cursor", async () => {
    const { shared, ddbSend } = buildShared();
    const lastKey = { PK: "DEPLOYMENT#X", SK: "META" };
    ddbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lastKey });

    const out = await listDeployments(shared, { tenantId: "tenant-acme" });
    expect(out.nextCursor).toBeDefined();
    const decoded = JSON.parse(Buffer.from(out.nextCursor ?? "", "base64url").toString("utf8"));
    expect(decoded).toEqual(lastKey);
  });

  it("should forward the cursor as ExclusiveStartKey", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    const startKey = { PK: "DEPLOYMENT#Y", SK: "META" };
    const cursor = Buffer.from(JSON.stringify(startKey), "utf8").toString("base64url");

    await listDeployments(shared, { tenantId: "tenant-acme", cursor });

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.ExclusiveStartKey).toEqual(startKey);
  });

  it("should ignore invalid cursors and start from the beginning", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

    await listDeployments(shared, { tenantId: "tenant-acme", cursor: "!!!not-valid!!!" });

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.ExclusiveStartKey).toBeUndefined();
  });

  it("Issue #862: should ignore cursors containing keys outside the allowlist (injection guard)", async () => {
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

  it("Issue #862: should ignore overly long cursors (DoS guard)", async () => {
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

  it("should clamp limit to 1–200", async () => {
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

  it("should issue a GetItem on PK=DEPLOYMENT#<jobId> SK=META", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });

    await getDeployment(shared, "tenant-acme", "01HABC");

    const cmd = ddbSend.mock.calls[0]?.[0] as GetCommand;
    expect(cmd).toBeInstanceOf(GetCommand);
    expect(cmd.input.Key).toEqual({ PK: "DEPLOYMENT#01HABC", SK: "META" });
  });

  it("should return undefined when the row is missing", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });

    const out = await getDeployment(shared, "tenant-acme", "01HABC");
    expect(out).toBeUndefined();
  });

  it("should return undefined for rows whose tenantId does not match (cross-tenant leak guard)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow({ tenantId: "tenant-other" }) });

    const out = await getDeployment(shared, "tenant-acme", "01HABC");
    expect(out).toBeUndefined();
  });

  it("should include teamLoginKey for operators", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });

    const out = await getDeployment(shared, "tenant-acme", "01HABC");
    expect(out).toBeDefined();
    expect(out?.teamLoginKey).toBe("SECRET_LOGIN_KEY_DO_NOT_LEAK");
  });

  it("listing should not include teamLoginKey", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    const out = await listDeployments(shared, { tenantId: "tenant-acme" });
    expect(out.items).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain("SECRET_LOGIN_KEY_DO_NOT_LEAK");
    expect((out.items[0] as { teamLoginKey?: string }).teamLoginKey).toBeUndefined();
  });
});
