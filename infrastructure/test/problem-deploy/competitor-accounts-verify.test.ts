import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompetitorAccountsSharedResources } from "../../lib/problem-deploy/handlers/competitor-accounts-handler/shared";
import { CompetitorAccountNotFoundError } from "../../lib/problem-deploy/handlers/competitor-accounts-handler/store";
import {
  AssumeRoleSanityCheckFailedError,
  ExternalIdMissingError,
  verifyCompetitorAccount,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/verify";

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

  it("STS AssumeRole を ExternalId 付きで発行し、成功時に verified=true を立てるべき", async () => {
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
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "external-id-abc" } });
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

  it("row が無ければ CompetitorAccountNotFoundError を投げるべき", async () => {
    const { shared, ddbSend, ssmSend, stsSend } = buildShared();
    // DDB Get + SSM GetParameter は Promise.all で並列発火されるので両方 mock 必要
    ddbSend.mockResolvedValueOnce({}); // not found
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "external-id-abc" } });

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

  it("SSM に ExternalId が無ければ ExternalIdMissingError を投げ STS を呼ばないべき", async () => {
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

  it("STS AssumeRole 失敗時は AssumeRoleSanityCheckFailedError に変換するべき (= operator に AccessDenied を見せる)", async () => {
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
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "external-id-abc" } });
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
});
