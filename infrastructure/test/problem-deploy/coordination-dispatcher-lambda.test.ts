import { Match, type Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthCoordinationDispatcherLambdaOnly,
  synthCoordinationDispatcherLambdaPureTurso,
} from "../problem-deploy-backend-stack.test-helpers";

/**
 * Issue #1420: 専用 CoordinationDispatcherLambda の最小 IAM 境界を pin する。
 * 核心は「participant-portal Lambda が持つ sts:AssumeRole / ssm / kms を **継承しない**」こと
 * (= 未信頼の問題同梱 plugin を将来 in-process 実行しても competitor 資格情報・ExternalId に
 * 構造的に到達不能にすること)。
 */

// Role の **inline 権限ポリシー** (= Properties.Policies) の action を集める。 trust policy
// (AssumeRolePolicyDocument) は除外する (= 全 role が sts:AssumeRole を含むため、 権限境界の検証対象外)。
function allActions(tpl: Template): string[] {
  return Object.values(tpl.findResources("AWS::IAM::Role")).flatMap((r) => {
    const policies =
      (
        r as {
          Properties?: { Policies?: Array<{ PolicyDocument?: { Statement?: unknown[] } }> };
        }
      ).Properties?.Policies ?? [];
    return policies.flatMap((p) =>
      (p.PolicyDocument?.Statement ?? []).flatMap((s) => {
        const a = (s as { Action?: string | string[] }).Action;
        return Array.isArray(a) ? a : typeof a === "string" ? [a] : [];
      }),
    );
  });
}

/**
 * Actions from standalone `AWS::IAM::Policy` resources. `allActions` above only reads a
 * Role's *inline* `Properties.Policies`, and `addToRolePolicy` emits a separate Policy
 * resource — so a check written against `allActions` alone silently passes whether or not
 * the grant exists.
 */
interface PolicyStatementShape {
  readonly Action?: unknown;
  readonly Resource?: unknown;
}

function attachedPolicyStatements(tpl: Template): PolicyStatementShape[] {
  return Object.values(tpl.findResources("AWS::IAM::Policy")).flatMap(
    (r) =>
      ((r as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } }).Properties
        ?.PolicyDocument?.Statement ?? []) as PolicyStatementShape[],
  );
}

function statementActions(statement: PolicyStatementShape): string[] {
  if (Array.isArray(statement.Action)) return statement.Action as string[];
  return typeof statement.Action === "string" ? [statement.Action] : [];
}

function attachedActions(tpl: Template): string[] {
  return attachedPolicyStatements(tpl).flatMap(statementActions);
}

describe("CoordinationDispatcherLambda", () => {
  it(
    "should provision a Node.js 22 / arm64 Lambda with a Function URL (AuthType=NONE)",
    () => {
      const tpl = synthCoordinationDispatcherLambdaOnly();
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({ Runtime: "nodejs22.x", Architectures: ["arm64"] }),
      );
      tpl.hasResourceProperties("AWS::Lambda::Url", Match.objectLike({ AuthType: "NONE" }));
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should pass the table-name env required by the shared builder",
    () => {
      const tpl = synthCoordinationDispatcherLambdaOnly();
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Environment: Match.objectLike({
            Variables: Match.objectLike({
              DEPLOYMENTS_TABLE_NAME: Match.anyValue(),
              EVENTS_TABLE_NAME: Match.anyValue(),
              DEPLOY_ENVIRONMENT: "development",
            }),
          }),
        }),
      );
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should grant scoped DynamoDB access but NOT sts:AssumeRole / ssm / kms",
    () => {
      const tpl = synthCoordinationDispatcherLambdaOnly();
      const actions = allActions(tpl);
      // team-login-key 認証 (Query) + coordination state 行 (Get/Put/Update) は持つ。
      expect(actions).toContain("dynamodb:Query");
      expect(actions).toContain("dynamodb:GetItem");
      expect(actions).toContain("dynamodb:PutItem");
      // [Issue #3123] tick の TTL 延長 (`touchCoordinationState`) が UpdateItem を使う。
      // 無いと refresh が AccessDenied で落ち、 warn に飲まれて retention が黙って壊れる。
      expect(actions).toContain("dynamodb:UpdateItem");
      // namespace の削除は event を所有する経路の責務であって、 plugin を実行するこの
      // Lambda のものではない。
      expect(actions).not.toContain("dynamodb:DeleteItem");
      // competitor 資格情報・ExternalId への経路は **存在しない**。
      expect(actions).not.toContain("sts:AssumeRole");
      expect(actions).not.toContain("ssm:GetParameter");
      expect(actions).not.toContain("kms:Decrypt");
    },
    SYNTH_TIMEOUT_MS,
  );
});

describe("CoordinationDispatcherLambda on the pure-SQL (turso) profile", () => {
  /**
   * Issue 486. The pure-SQL profile synthesizes no control-data tables, and the dispatcher
   * used to be given nothing in their place, so `resolveDeploymentsRepository` fell through
   * to the DynamoDB branch and threw `dynamodb backend requires ddb/deploymentsTableName.`
   * on every request. Live symptom: every coordination-plugin battle showed
   * `coordination status: not_configured` and never supplied a single Contract.
   */
  it(
    "should carry the backend triple the repository seam needs to build a SQL executor",
    () => {
      const tpl = synthCoordinationDispatcherLambdaPureTurso();
      const variables = Object.values(tpl.findResources("AWS::Lambda::Function")).flatMap(
        (r) =>
          (r as { Properties?: { Environment?: { Variables?: Record<string, string> } } })
            .Properties?.Environment?.Variables ?? [],
      );
      expect(variables).toHaveLength(1);
      expect(variables[0]).toMatchObject({
        CONTROL_DATA_BACKEND: "turso",
        TURSO_DATABASE_URL: "https://example-db.turso.io",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/development/turso/auth-token",
      });
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should read the auth token from exactly one SSM parameter, not the whole path",
    () => {
      const tpl = synthCoordinationDispatcherLambdaPureTurso();
      const reads = attachedActions(tpl).filter((action) => action === "ssm:GetParameter");
      expect(reads).toHaveLength(1);
      const ssm = attachedPolicyStatements(tpl).filter((s) =>
        statementActions(s).includes("ssm:GetParameter"),
      );
      expect(JSON.stringify(ssm)).toContain("TenkaCloud/development/turso/auth-token");
      expect(JSON.stringify(ssm)).not.toContain("parameter/*");
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should leave the DynamoDB profile's environment and IAM untouched",
    () => {
      const tpl = synthCoordinationDispatcherLambdaOnly();
      const envs = Object.values(tpl.findResources("AWS::Lambda::Function")).map((r) =>
        JSON.stringify(
          (r as { Properties?: { Environment?: unknown } }).Properties?.Environment ?? {},
        ),
      );
      for (const env of envs) {
        expect(env).not.toContain("CONTROL_DATA_BACKEND");
        expect(env).not.toContain("TURSO_");
      }
      expect([...allActions(tpl), ...attachedActions(tpl)]).not.toContain("ssm:GetParameter");
    },
    SYNTH_TIMEOUT_MS,
  );
});
