import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { resolveVerifiedCompetitorAccount } from "../../lib/problem-deploy/handlers/shared/competitor-account-lookup";

const TENANT_ID = "tenant-acme";
const ACCOUNT_ID = "123456789012";

function buildDeps(send: ReturnType<typeof vi.fn>) {
  return {
    ddb: { send } as unknown as Parameters<typeof resolveVerifiedCompetitorAccount>[0]["ddb"],
    competitorAccountsTableName: "TestCompetitorAccounts",
    env: "development",
  };
}

describe("resolveVerifiedCompetitorAccount", () => {
  it("should return RoleArn / externalIdParameterName when a verified=true row exists", async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        PK: `TENANT#${TENANT_ID}`,
        SK: `ACCOUNT#${ACCOUNT_ID}`,
        tenantId: TENANT_ID,
        awsAccountId: ACCOUNT_ID,
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: true,
      },
    });
    const out = await resolveVerifiedCompetitorAccount(buildDeps(send), TENANT_ID, ACCOUNT_ID);
    expect(out).toEqual({
      awsAccountId: ACCOUNT_ID,
      competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
      region: "ap-northeast-1",
      externalIdParameterName: `/development/tenants/${TENANT_ID}/external-id`,
      competitorRoleArn: `arn:aws:iam::${ACCOUNT_ID}:role/TenkaCloud-CompetitorDeploy-Role`,
    });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
  });

  it("should return null for verified=false rows (trigger for backend reject)", async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        PK: `TENANT#${TENANT_ID}`,
        SK: `ACCOUNT#${ACCOUNT_ID}`,
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: false,
      },
    });
    const out = await resolveVerifiedCompetitorAccount(buildDeps(send), TENANT_ID, ACCOUNT_ID);
    expect(out).toBeNull();
  });

  it("should return null when the row does not exist", async () => {
    const send = vi.fn().mockResolvedValue({});
    const out = await resolveVerifiedCompetitorAccount(buildDeps(send), TENANT_ID, ACCOUNT_ID);
    expect(out).toBeNull();
  });

  it("should return null when competitorRoleName is empty (defense against deploy-impossible state)", async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        verified: true,
        competitorRoleName: "",
      },
    });
    const out = await resolveVerifiedCompetitorAccount(buildDeps(send), TENANT_ID, ACCOUNT_ID);
    expect(out).toBeNull();
  });
});
