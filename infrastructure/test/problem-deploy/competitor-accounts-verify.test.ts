import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompetitorAccountsSharedResources } from "../../lib/problem-deploy/handlers/competitor-accounts-handler/shared";
import { CompetitorAccountNotFoundError } from "../../lib/problem-deploy/handlers/competitor-accounts-handler/store";
import {
  AssumeRoleSanityCheckFailedError,
  ExternalIdMissingError,
  verifyCompetitorAccount,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/verify";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const NOW_MS = 1_700_000_000_000;

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

describe("verifyCompetitorAccount", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should issue STS AssumeRole with ExternalId and set verified=true on success", async () => {
    const { shared, ddbSend, ssmSend, stsSend } = buildShared();
    // 1. DDB.Get で row 取得
    ddbSend.mockResolvedValueOnce({
      Item: {
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    // 2. SSM.Get で ExternalId
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "external-id-abc", Version: 1 } });
    // 3. STS.AssumeRole 成功
    stsSend.mockResolvedValueOnce({});
    // 4. DDB.Update で verified=true
    ddbSend.mockResolvedValueOnce({
      Attributes: {
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: true,
        verifiedAt: new Date(NOW_MS).toISOString(),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: new Date(NOW_MS).toISOString(),
      },
    });

    const out = await verifyCompetitorAccount(shared, {
      tenantId: "tenant-acme",
      awsAccountId: "222222222222",
      nowMs: NOW_MS,
    });

    // AssumeRole が ExternalId 付きで呼ばれていること (= Confused Deputy 対策)
    const stsCmd = stsSend.mock.calls[0]?.[0] as AssumeRoleCommand;
    expect(stsCmd).toBeInstanceOf(AssumeRoleCommand);
    expect(stsCmd.input.RoleArn).toBe(
      "arn:aws:iam::222222222222:role/TenkaCloud-CompetitorDeploy-Role",
    );
    expect(stsCmd.input.ExternalId).toBe("external-id-abc");
    expect(stsCmd.input.RoleSessionName).toBeTruthy();

    expect(out.verified).toBe(true);
    expect(out.verifiedAt).toBeTruthy();
  });

  it("should throw CompetitorAccountNotFoundError when the row is missing", async () => {
    const { shared, ddbSend, ssmSend, stsSend } = buildShared();
    // DDB Get + SSM GetParameter は Promise.all で並列発火されるので両方 mock 必要
    ddbSend.mockResolvedValueOnce({}); // not found
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "external-id-abc", Version: 1 } });

    await expect(
      verifyCompetitorAccount(shared, {
        tenantId: "tenant-acme",
        awsAccountId: "999999999999",
        nowMs: NOW_MS,
      }),
    ).rejects.toBeInstanceOf(CompetitorAccountNotFoundError);

    // STS は呼ばれない
    expect(stsSend.mock.calls.length).toBe(0);
  });

  it("should throw ExternalIdMissingError without calling STS when ExternalId is missing in SSM", async () => {
    const { shared, ddbSend, ssmSend, stsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: {
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    ssmSend.mockRejectedValueOnce(Object.assign(new Error("nope"), { name: "ParameterNotFound" }));

    await expect(
      verifyCompetitorAccount(shared, {
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        nowMs: NOW_MS,
      }),
    ).rejects.toBeInstanceOf(ExternalIdMissingError);
    expect(stsSend.mock.calls.length).toBe(0);
  });

  it("should convert STS AssumeRole failure to AssumeRoleSanityCheckFailedError (show AccessDenied to operator)", async () => {
    const { shared, ddbSend, ssmSend, stsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: {
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "external-id-abc", Version: 1 } });
    stsSend.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDenied" }));

    const thrown = await verifyCompetitorAccount(shared, {
      tenantId: "tenant-acme",
      awsAccountId: "222222222222",
      nowMs: NOW_MS,
    }).then(
      () => null,
      (e) => e as unknown,
    );
    expect(thrown).toBeInstanceOf(AssumeRoleSanityCheckFailedError);
    expect((thrown as AssumeRoleSanityCheckFailedError).underlyingErrorName).toBe("AccessDenied");

    // verify 失敗時は DDB.Update は呼ばれない (= verified=false のまま残る)
    expect(ddbSend.mock.calls.length).toBe(1);
  });

  it("#856: should retry with the previous-generation ExternalId on AccessDenied when version > 1 (rotate race grace)", async () => {
    const { shared, ddbSend, ssmSend, stsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: {
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    // 1st SSM: $LATEST = v=3 (rotate 直後の新値)
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "external-id-new", Version: 3 } });
    // 1st STS AssumeRole: AccessDenied (competitor 側 Trust Policy がまだ v=2 を期待している)
    stsSend.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    // 2nd SSM: version=2 (= 3-1) を fetch
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "external-id-old", Version: 2 } });
    // 2nd STS AssumeRole: 旧 ExternalId で成功
    stsSend.mockResolvedValueOnce({});
    // markVerified の DDB.Update
    ddbSend.mockResolvedValueOnce({
      Attributes: {
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        verified: true,
        verifiedAt: new Date(NOW_MS).toISOString(),
      },
    });

    const out = await verifyCompetitorAccount(shared, {
      tenantId: "tenant-acme",
      awsAccountId: "222222222222",
      nowMs: NOW_MS,
    });

    expect(out.verified).toBe(true);
    expect(stsSend.mock.calls).toHaveLength(2);
    const firstStsCmd = stsSend.mock.calls[0]?.[0] as AssumeRoleCommand;
    const secondStsCmd = stsSend.mock.calls[1]?.[0] as AssumeRoleCommand;
    expect(firstStsCmd.input.ExternalId).toBe("external-id-new");
    expect(secondStsCmd.input.ExternalId).toBe("external-id-old");
  });

  it("#856: should fail immediately without fallback when version=1 (= no rotation yet / real Trust Policy mismatch)", async () => {
    const { shared, ddbSend, ssmSend, stsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: {
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "external-id-init", Version: 1 } });
    stsSend.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDenied" }));

    await expect(
      verifyCompetitorAccount(shared, {
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        nowMs: NOW_MS,
      }),
    ).rejects.toBeInstanceOf(AssumeRoleSanityCheckFailedError);

    // STS は 1 度のみ (= fallback retry なし)
    expect(stsSend.mock.calls).toHaveLength(1);
    // SSM も 1 度のみ (= getExternalIdByVersion を呼ばない)
    expect(ssmSend.mock.calls).toHaveLength(1);
  });

  it("#856: fallback 経路でも 2 回目が失敗したら AssumeRoleSanityCheckFailedError を 2 回目の error 名で投げる", async () => {
    const { shared, ddbSend, ssmSend, stsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: {
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "external-id-new", Version: 3 } });
    stsSend.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "external-id-old", Version: 2 } });
    stsSend.mockRejectedValueOnce(
      Object.assign(new Error("malformed"), { name: "ValidationError" }),
    );

    const thrown = await verifyCompetitorAccount(shared, {
      tenantId: "tenant-acme",
      awsAccountId: "222222222222",
      nowMs: NOW_MS,
    }).then(
      () => null,
      (e) => e as unknown,
    );
    expect(thrown).toBeInstanceOf(AssumeRoleSanityCheckFailedError);
    expect((thrown as AssumeRoleSanityCheckFailedError).underlyingErrorName).toBe(
      "ValidationError",
    );
  });
});
