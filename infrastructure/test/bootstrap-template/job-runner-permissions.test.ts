import { describe, expect, it } from "vitest";
import { buildTenantJobRunnerPermissions } from "../../lib/bootstrap-template/job-runner-permissions";

/**
 * #1382: SBT BashJobRunner の `Action:* Resource:*` を provision/deprovision-tenant.sh が実際に
 * 必要とする最小権限へ絞ったことを pin する。 SBT construct 自体は不変、 渡す permissions のみ scope。
 */
function statements(account = "123456789012", region = "ap-northeast-1") {
  const doc = buildTenantJobRunnerPermissions(account, region);
  const json = doc.toJSON() as { Statement: Array<Record<string, unknown>> };
  return json.Statement;
}

function actionsOf(stmts: Array<Record<string, unknown>>): string[] {
  return stmts.flatMap((s) => {
    const a = s.Action;
    return Array.isArray(a) ? (a as string[]) : typeof a === "string" ? [a] : [];
  });
}

describe("buildTenantJobRunnerPermissions (#1382)", () => {
  it("should NOT grant the SBT-example account-admin wildcard (Action:* / Resource:*)", () => {
    const stmts = statements();
    const actions = actionsOf(stmts);
    expect(actions).not.toContain("*");
    // 唯一の Resource:* は sts:GetCallerIdentity (resource-level 非対応) のみ。
    const starResourceStmts = stmts.filter((s) => s.Resource === "*");
    expect(starResourceStmts).toHaveLength(1);
    expect(actionsOf(starResourceStmts)).toEqual(["sts:GetCallerIdentity"]);
  });

  it("should delegate resource creation to the cdk-* bootstrap roles via sts:AssumeRole", () => {
    const stmts = statements();
    const assume = stmts.find(
      (s) => Array.isArray(s.Action) === false && s.Action === "sts:AssumeRole",
    );
    expect(assume?.Resource).toBe("arn:aws:iam::123456789012:role/cdk-*");
  });

  it("should scope cloudformation/cognito/s3/ssm to TenkaCloud-specific ARNs", () => {
    const stmts = statements();
    const resources = stmts.flatMap((s) => {
      const r = s.Resource;
      return Array.isArray(r) ? (r as string[]) : typeof r === "string" ? [r] : [];
    });
    expect(resources).toContain(
      "arn:aws:cloudformation:ap-northeast-1:123456789012:stack/tenkacloud-tenant-template-*/*",
    );
    expect(resources).toContain("arn:aws:cognito-idp:ap-northeast-1:123456789012:userpool/*");
    expect(resources).toContain("arn:aws:s3:::tenkacloud-source-123456789012-ap-northeast-1");
    expect(resources).toContain(
      "arn:aws:ssm:ap-northeast-1:123456789012:parameter/cdk-bootstrap/*",
    );
  });

  it("should grant the Cognito admin actions the provision script uses (and only those)", () => {
    const actions = actionsOf(statements());
    for (const a of [
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminUpdateUserAttributes",
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:CreateGroup",
      "cognito-idp:GetGroup",
    ]) {
      expect(actions).toContain(a);
    }
    // tenant 越境の温床になりやすい広域 cognito 権限は持たない。
    expect(actions).not.toContain("cognito-idp:*");
    expect(actions).not.toContain("cognito-idp:ListUserPools");
  });
});
