import { PutParameterCommand } from "@aws-sdk/client-ssm";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompetitorAccountsSharedResources } from "../../lib/problem-deploy/handlers/competitor-accounts-handler/shared";
import {
  CompetitorAccountNotFoundError,
  createCompetitorAccount,
  DuplicateCompetitorAccountError,
  deleteCompetitorAccount,
  ExternalIdMissingForRotationError,
  getCompetitorAccount,
  listCompetitorAccounts,
  markCompetitorAccountVerified,
  rotateExternalIdForAccount,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/store";

const NOW_MS = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

function buildShared(): {
  shared: CompetitorAccountsSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
  ssmSend: ReturnType<typeof vi.fn>;
  stsSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const ssmSend = vi.fn();
  const stsSend = vi.fn();
  const shared: CompetitorAccountsSharedResources = {
    tableName: "TestCompetitorAccounts",
    env: "development",
    tenkaCloudAccountId: "111111111111",
    ddb: { send: ddbSend } as unknown as CompetitorAccountsSharedResources["ddb"],
    ssm: { send: ssmSend } as unknown as CompetitorAccountsSharedResources["ssm"],
    sts: { send: stsSend } as unknown as CompetitorAccountsSharedResources["sts"],
  };
  return { shared, ddbSend, ssmSend, stsSend };
}

describe("createCompetitorAccount", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SSM SecureString に ExternalId を Put し DDB に verified=false の row を書くべき", async () => {
    const { shared, ddbSend, ssmSend } = buildShared();
    // 1 回目の SSM.Get は ParameterNotFound、続く Put は成功、最後 DDB.Put 成功。
    ssmSend
      .mockRejectedValueOnce(Object.assign(new Error("nope"), { name: "ParameterNotFound" }))
      .mockResolvedValueOnce({});
    ddbSend.mockResolvedValueOnce({});

    const out = await createCompetitorAccount(
      shared,
      { tenantId: "tenant-acme", nowMs: NOW_MS, createdBy: "user-sub-1" },
      {
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
      },
    );

    // SSM Put が SecureString 型で呼ばれる
    const putParamCall = ssmSend.mock.calls[1]?.[0] as PutParameterCommand;
    expect(putParamCall).toBeInstanceOf(PutParameterCommand);
    expect(putParamCall.input.Type).toBe("SecureString");
    expect(putParamCall.input.Name).toBe("/development/tenants/tenant-acme/external-id");
    expect(putParamCall.input.Overwrite).toBe(false);
    // ExternalId は 64 文字の hex
    expect(typeof putParamCall.input.Value).toBe("string");
    expect((putParamCall.input.Value as string).length).toBe(64);

    // DDB Put が verified=false の正しい shape を書く
    const ddbPut = ddbSend.mock.calls[0]?.[0] as PutCommand;
    expect(ddbPut).toBeInstanceOf(PutCommand);
    expect(ddbPut.input.Item).toMatchObject({
      PK: "TENANT#tenant-acme",
      SK: "ACCOUNT#222222222222",
      tenantId: "tenant-acme",
      awsAccountId: "222222222222",
      verified: false,
      createdBy: "user-sub-1",
      region: "ap-northeast-1",
      competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
    });
    expect(ddbPut.input.ConditionExpression).toContain("attribute_not_exists(PK)");

    // 戻り値に externalId / tenkaCloudAccountId が 1 度だけ露出される
    expect(out.externalId).toBe(putParamCall.input.Value);
    expect(out.tenkaCloudAccountId).toBe("111111111111");
    expect(out.verified).toBe(false);
  });

  it("SSM に既存値があれば ExternalId を回さず既存値を返すべき (= 冪等)", async () => {
    const { shared, ddbSend, ssmSend } = buildShared();
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "existing-external-id-xyz" } });
    ddbSend.mockResolvedValueOnce({});

    const out = await createCompetitorAccount(
      shared,
      { tenantId: "tenant-acme", nowMs: NOW_MS, createdBy: "user-sub-1" },
      {
        awsAccountId: "333333333333",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
      },
    );

    // PutParameter は呼ばれない
    expect(ssmSend.mock.calls.length).toBe(1);
    expect(out.externalId).toBe("existing-external-id-xyz");
  });

  it("同 (tenantId, awsAccountId) を 2 度作ろうとすると DuplicateCompetitorAccountError を投げるべき", async () => {
    const { shared, ddbSend, ssmSend } = buildShared();
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "ext-id" } });
    ddbSend.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), { name: "ConditionalCheckFailedException" }),
    );

    await expect(
      createCompetitorAccount(
        shared,
        { tenantId: "tenant-acme", nowMs: NOW_MS, createdBy: "user-sub-1" },
        {
          awsAccountId: "222222222222",
          region: "ap-northeast-1",
          competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        },
      ),
    ).rejects.toBeInstanceOf(DuplicateCompetitorAccountError);
  });
});

describe("listCompetitorAccounts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Query PK=TENANT# / SK begins_with ACCOUNT# で全 row を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          tenantId: "tenant-acme",
          awsAccountId: "222222222222",
          region: "ap-northeast-1",
          competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
          verified: true,
          verifiedAt: NOW_ISO,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
        {
          tenantId: "tenant-acme",
          awsAccountId: "333333333333",
          region: "ap-northeast-1",
          competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
          verified: false,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      ],
    });

    const out = await listCompetitorAccounts(shared, "tenant-acme");
    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd).toBeInstanceOf(QueryCommand);
    expect(cmd.input.KeyConditionExpression).toBe("PK = :pk AND begins_with(SK, :sk)");
    expect(cmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");

    expect(out).toHaveLength(2);
    expect(out[0]?.verified).toBe(true);
    expect(out[1]?.verified).toBe(false);
  });
});

describe("getCompetitorAccount", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Get が undefined Item を返すと undefined を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({});
    const out = await getCompetitorAccount(shared, "tenant-acme", "999999999999");
    expect(out).toBeUndefined();
    const cmd = ddbSend.mock.calls[0]?.[0] as GetCommand;
    expect(cmd.input.Key).toEqual({ PK: "TENANT#tenant-acme", SK: "ACCOUNT#999999999999" });
  });
});

describe("markCompetitorAccountVerified", () => {
  beforeEach(() => vi.clearAllMocks());

  it("UpdateCommand で verified=true / verifiedAt を立てるべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Attributes: {
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: true,
        verifiedAt: NOW_ISO,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    });

    const out = await markCompetitorAccountVerified(shared, {
      tenantId: "tenant-acme",
      awsAccountId: "222222222222",
      verifiedAt: NOW_ISO,
    });

    const cmd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    expect(cmd).toBeInstanceOf(UpdateCommand);
    expect(cmd.input.ConditionExpression).toContain("attribute_exists(PK)");
    expect(cmd.input.UpdateExpression).toContain("verified = :v");
    expect(cmd.input.ExpressionAttributeValues?.[":v"]).toBe(true);
    expect(cmd.input.ExpressionAttributeValues?.[":va"]).toBe(NOW_ISO);

    expect(out.verified).toBe(true);
    expect(out.verifiedAt).toBe(NOW_ISO);
  });

  it("ConditionalCheckFailedException は CompetitorAccountNotFoundError に変換するべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), { name: "ConditionalCheckFailedException" }),
    );

    await expect(
      markCompetitorAccountVerified(shared, {
        tenantId: "tenant-acme",
        awsAccountId: "999999999999",
        verifiedAt: NOW_ISO,
      }),
    ).rejects.toBeInstanceOf(CompetitorAccountNotFoundError);
  });
});

describe("deleteCompetitorAccount", () => {
  beforeEach(() => vi.clearAllMocks());

  it("row が存在しなければ CompetitorAccountNotFoundError を投げるべき", async () => {
    const { shared, ddbSend, ssmSend } = buildShared();
    // ConditionExpression が落ちて ConditionalCheckFailedException を SDK が投げる挙動。
    ddbSend.mockRejectedValueOnce(
      Object.assign(new Error("Condition"), { name: "ConditionalCheckFailedException" }),
    );

    await expect(
      deleteCompetitorAccount(shared, "tenant-acme", "999999999999"),
    ).rejects.toBeInstanceOf(CompetitorAccountNotFoundError);

    // 残行 Count Query は呼ばない (= Delete 失敗で短絡)
    expect(ddbSend.mock.calls.length).toBe(1);
    expect(ssmSend.mock.calls.length).toBe(0);
  });

  it("最後の 1 行を消したら SSM の ExternalId も削除するべき", async () => {
    const { shared, ddbSend, ssmSend } = buildShared();
    ddbSend
      // DeleteCommand 成功
      .mockResolvedValueOnce({})
      // QueryCommand (Select=COUNT) で残行 0 件
      .mockResolvedValueOnce({ Count: 0 });
    // SSM DeleteParameter
    ssmSend.mockResolvedValueOnce({});

    await deleteCompetitorAccount(shared, "tenant-acme", "222222222222");

    expect(ddbSend.mock.calls[0]?.[0]).toBeInstanceOf(DeleteCommand);
    expect(ssmSend.mock.calls.length).toBe(1);
  });

  it("他の row が残っていれば SSM の ExternalId は触らないべき", async () => {
    const { shared, ddbSend, ssmSend } = buildShared();
    ddbSend
      .mockResolvedValueOnce({})
      // COUNT=1 (= 残行あり)
      .mockResolvedValueOnce({ Count: 1 });

    await deleteCompetitorAccount(shared, "tenant-acme", "222222222222");

    expect(ssmSend.mock.calls.length).toBe(0);
  });
});

describe("rotateExternalIdForAccount", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SSM Parameter を Overwrite=true で Put し DDB の rotatedAt を更新するべき", async () => {
    const { shared, ddbSend, ssmSend } = buildShared();
    // 1. DDB Get で既存 row 確認 → Item あり
    ddbSend.mockResolvedValueOnce({
      Item: {
        PK: "TENANT#tenant-acme",
        SK: "ACCOUNT#222222222222",
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: true,
        verifiedAt: NOW_ISO,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    });
    // 2. SSM GetParameter で現値あり
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "old-external-id" } });
    // 3. SSM PutParameter (Overwrite=true)
    ssmSend.mockResolvedValueOnce({});
    // 4. DDB Update — Attributes には rotatedAt が乗る
    ddbSend.mockResolvedValueOnce({
      Attributes: {
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: true,
        verifiedAt: NOW_ISO,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        rotatedAt: NOW_ISO,
      },
    });

    const out = await rotateExternalIdForAccount(shared, {
      tenantId: "tenant-acme",
      awsAccountId: "222222222222",
      nowMs: NOW_MS,
    });

    // SSM PutParameter 呼び出しを検査 (= Overwrite:true, SecureString, 64 文字 hex)
    const putParamCall = ssmSend.mock.calls[1]?.[0] as PutParameterCommand;
    expect(putParamCall).toBeInstanceOf(PutParameterCommand);
    expect(putParamCall.input.Type).toBe("SecureString");
    expect(putParamCall.input.Overwrite).toBe(true);
    expect(putParamCall.input.Name).toBe("/development/tenants/tenant-acme/external-id");
    expect(typeof putParamCall.input.Value).toBe("string");
    expect((putParamCall.input.Value as string).length).toBe(64);

    // DDB Update が rotatedAt を立てている
    const updateCmd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCmd).toBeInstanceOf(UpdateCommand);
    expect(updateCmd.input.UpdateExpression).toContain("rotatedAt = :r");
    expect(updateCmd.input.ExpressionAttributeValues?.[":r"]).toBe(NOW_ISO);
    expect(updateCmd.input.ExpressionAttributeValues?.[":u"]).toBe(NOW_ISO);

    // 戻り値: 新 ExternalId + tenkaCloudAccountId + rotatedAt
    expect(out.externalId).toBe(putParamCall.input.Value);
    expect(out.externalId).not.toBe("old-external-id");
    expect(out.tenkaCloudAccountId).toBe("111111111111");
    expect(out.rotatedAt).toBe(NOW_ISO);
  });

  it("row が無ければ CompetitorAccountNotFoundError を投げ SSM Put しないべき", async () => {
    const { shared, ddbSend, ssmSend } = buildShared();
    // Get が Item を返さない
    ddbSend.mockResolvedValueOnce({});

    await expect(
      rotateExternalIdForAccount(shared, {
        tenantId: "tenant-acme",
        awsAccountId: "999999999999",
        nowMs: NOW_MS,
      }),
    ).rejects.toBeInstanceOf(CompetitorAccountNotFoundError);

    // GetCommand 1 度のみ。SSM は触らない。
    expect(ddbSend.mock.calls.length).toBe(1);
    expect(ddbSend.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
    expect(ssmSend.mock.calls.length).toBe(0);
  });

  it("SSM に現 ExternalId が無ければ ExternalIdMissingForRotationError を投げ Put しないべき", async () => {
    const { shared, ddbSend, ssmSend } = buildShared();
    // 1. Get Item OK
    ddbSend.mockResolvedValueOnce({
      Item: {
        PK: "TENANT#tenant-acme",
        SK: "ACCOUNT#222222222222",
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: true,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    });
    // 2. SSM GetParameter で ParameterNotFound
    ssmSend.mockRejectedValueOnce(Object.assign(new Error("nope"), { name: "ParameterNotFound" }));

    await expect(
      rotateExternalIdForAccount(shared, {
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        nowMs: NOW_MS,
      }),
    ).rejects.toBeInstanceOf(ExternalIdMissingForRotationError);

    // SSM Get 1 度のみ、Put は呼ばない
    expect(ssmSend.mock.calls.length).toBe(1);
  });
});
