import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import {
  LAMBDA_NODEJS_BUNDLING_TARGET,
  LAMBDA_NODEJS_RUNTIME,
  LAMBDA_SOURCE_MAP_ENABLED,
} from "../utils/lambda-runtime";
import { buildExternalIdParameterArnPattern } from "./handlers/shared/external-id-store.js";

export interface CompetitorAccountsApiLambdaProps {
  readonly competitorAccountsTable: Table;
  /** SSM SecureString path 構築用 (`/<env>/tenants/<tenantId>/external-id`)。 */
  readonly environmentName: string;
  /**
   * Issue #950 (ADR-020 Phase D): admin 操作 audit log 用 DDB Table。 deploy-api-lambda と同じ。
   */
  readonly adminAuditLogTable?: Table;
}

/**
 * Competitor Accounts API Lambda (Issue #459 / ADR-002 Phase 2.1)。
 *
 * tenant API (TenantTemplateStack の REST API + Cognito JWT authorizer) から
 * `LambdaIntegration` で invoke される。Hono routes:
 *   POST   /admin/competitor-accounts
 *   GET    /admin/competitor-accounts
 *   POST   /admin/competitor-accounts/{awsAccountId}/verify
 *   DELETE /admin/competitor-accounts/{awsAccountId}
 *
 * 最小権限の IAM (= scope を tenant の SSM path prefix に限定):
 *   - DDB `CompetitorAccounts` 全 RW
 *   - SSM `parameter/{env}/tenants/*\/external-id` の Get/Put/Delete (KMS managed key)
 *   - STS `AssumeRole` (= verify endpoint。resource は 12 桁 account の Role なので
 *     account 全体を `*` で許可、Action のみ限定する)
 *
 * 独立 Lambda にする理由 (= EventApi 等への相乗りを避ける):
 *   1. SSM SecureString Read/Write は機密 IAM なので最小化したい
 *   2. STS AssumeRole も同様 (= 他 handler に持たせると blast RADIUS が拡大)
 */
export class CompetitorAccountsApiLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: CompetitorAccountsApiLambdaProps) {
    super(scope, id);

    const stack = Stack.of(this);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: LAMBDA_NODEJS_RUNTIME,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/competitor-accounts-handler/index.ts"),
      handler: "handler",
      // verify endpoint は STS AssumeRole 1 回 (= ~1s) + DDB Update なので 10s で十分。
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        COMPETITOR_ACCOUNTS_TABLE_NAME: props.competitorAccountsTable.tableName,
        DEPLOY_ENVIRONMENT: props.environmentName,
        TENKACLOUD_ACCOUNT_ID: stack.account,
        // Issue #950: audit log table 名 (未配線なら空文字)
        ADMIN_AUDIT_LOG_TABLE_NAME: props.adminAuditLogTable?.tableName ?? "",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: LAMBDA_NODEJS_BUNDLING_TARGET,
        sourceMap: LAMBDA_SOURCE_MAP_ENABLED,
        externalModules: [],
      },
    });

    // 1. DDB CompetitorAccounts: PutItem / Query / GetItem / UpdateItem / DeleteItem
    props.competitorAccountsTable.grantReadWriteData(this.fn);
    // Issue #950 (ADR-020 Phase D): admin audit log は write-only。
    props.adminAuditLogTable?.grantWriteData(this.fn);

    // 2. SSM Parameter Store SecureString — tenant の path prefix で絞り込み。
    //    `/{env}/tenants/*/external-id` (= tenantId は wildcard、env は固定)。
    const ssmArn = buildExternalIdParameterArnPattern(
      stack.region,
      stack.account,
      props.environmentName,
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"],
        resources: [ssmArn],
      }),
    );
    // SSM SecureString は AWS managed key (alias/aws/ssm) で暗号化される。
    //   - GetParameter(WithDecryption=true) → `kms:Decrypt` を要求
    //   - PutParameter(Type=SecureString)  → `kms:GenerateDataKey` を要求 (envelope encryption)
    // AWS managed key の Resource ARN は account/region から構築できないので Resource:* + Condition で絞る。
    //
    // **StringLike** が必須: SSM が runtime に渡してくる EncryptionContext は **具体 tenantId** に
    // 展開された ARN (= `.../tenants/01HXYZ.../external-id`)。`StringEquals` だと wildcard を
    // 文字 `*` として扱い literal 比較に倒れ Condition が永遠に false で fail-closed になる。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["kms:Decrypt", "kms:GenerateDataKey"],
        resources: ["*"],
        conditions: {
          StringLike: {
            "kms:EncryptionContext:PARAMETER_ARN": ssmArn,
          },
        },
      }),
    );

    // 3. STS AssumeRole (verify endpoint)。Resource は 12 桁 account の競技者 IAM Role 形式に絞る。
    //    具体的な競技者 account ID は deploy 時点では決まらないので account を `*` にし、
    //    Role 名 pattern を `TenkaCloud-*` で絞る (= operator が好きな名前を付けても TenkaCloud- prefix は必須)。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: ["arn:aws:iam::*:role/TenkaCloud-*"],
      }),
    );

    // 4. Issue #839 follow-up Phase B: Tenant 管理者が自社の SAML IdP を画面から設定できるよう、
    //    同 Lambda に Cognito IdP mutation 権限を付ける。 Resource は自 account / region 配下の
    //    全 UserPool に絞り (= account-level blast radius)、 runtime 側で JWT iss claim から
    //    呼び出した UserPool ID を抽出して self-targeting のみ許可する。
    //
    //    cross-stack で具体 UserPool ARN を渡すと TenantTemplateStack ↔ ProblemDeployBackendStack
    //    間に CFn export 依存が増えるため、 wildcard + runtime guard で代用する設計判断。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "cognito-idp:CreateIdentityProvider",
          "cognito-idp:UpdateIdentityProvider",
          "cognito-idp:DescribeIdentityProvider",
          "cognito-idp:DeleteIdentityProvider",
          "cognito-idp:DescribeUserPoolClient",
          "cognito-idp:UpdateUserPoolClient",
        ],
        resources: [`arn:aws:cognito-idp:${stack.region}:${stack.account}:userpool/*`],
      }),
    );

    // 5. Issue #925 Phase 1: Tenant Admin が tenant 内 user を CRUD する route 用の Cognito 権限。
    //    SAML route と同じ self-targeting (= JWT iss から UserPool ID を runtime 抽出) で
    //    wildcard を絞り込む。 actions は最小権限:
    //      - AdminCreateUser / AdminDeleteUser / AdminGetUser: invite / delete / 越境チェック
    //      - ListUsers: tenant scoped list (= custom:tenantId filter で絞る)
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminDeleteUser",
          "cognito-idp:AdminGetUser",
          // Issue #17: AdminUpdateUserAttributes で custom:userRole を書き換える経路。
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:ListUsers",
        ],
        resources: [`arn:aws:cognito-idp:${stack.region}:${stack.account}:userpool/*`],
      }),
    );
  }
}
