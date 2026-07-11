import { PutParameterCommand } from "@aws-sdk/client-ssm";
import {
  DeleteCommand,
  type GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompetitorAccountsSharedResources } from "../../lib/problem-deploy/handlers/competitor-accounts-handler/shared";
import {
  CompetitorAccountNotFoundError,
  CompetitorAccountNotVerifiedError,
  createCompetitorAccount,
  DuplicateCompetitorAccountError,
  deleteCompetitorAccount,
  getCompetitorAccount,
  listCompetitorAccounts,
  markCompetitorAccountVerified,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/store";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

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
    runtime: makeTestControlDataRuntime(),
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

  it("should Put ExternalId into SSM SecureString and write a verified=false row to DDB", async () => {
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

  it("should return the existing value without rotating ExternalId when present in SSM (idempotent)", async () => {
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

  it("should throw DuplicateCompetitorAccountError on attempts to create the same (tenantId, awsAccountId) twice", async () => {
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

  it("should return all rows via Query PK=TENANT# / SK begins_with ACCOUNT#", async () => {
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

  it("should return undefined when Get returns an undefined Item", async () => {
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

  it("should set verified=true / verifiedAt via UpdateCommand", async () => {
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

  it("should convert ConditionalCheckFailedException to CompetitorAccountNotFoundError", async () => {
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

  it("should throw CompetitorAccountNotFoundError when the row does not exist", async () => {
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

  it("should also delete the ExternalId from SSM when the last remaining row is removed", async () => {
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

  it("should not touch SSM ExternalId while other rows remain", async () => {
    const { shared, ddbSend, ssmSend } = buildShared();
    ddbSend
      .mockResolvedValueOnce({})
      // COUNT=1 (= 残行あり)
      .mockResolvedValueOnce({ Count: 1 });

    await deleteCompetitorAccount(shared, "tenant-acme", "222222222222");

    expect(ssmSend.mock.calls.length).toBe(0);
  });

  it("should carry the awsAccountId and a verify-first hint on CompetitorAccountNotVerifiedError (#868 gate contract)", () => {
    const err = new CompetitorAccountNotVerifiedError("123456789012");
    expect(err.name).toBe("CompetitorAccountNotVerifiedError");
    expect(err.awsAccountId).toBe("123456789012");
    expect(err.message).toContain("123456789012");
    expect(err.message).toContain("verify");
  });
});
