import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";
import { auditLogEnabledEnv } from "./audit-log-env.js";
import { controlDataBackendEnv } from "./control-data-backend-env.js";
import { buildAzureCredentialParameterArnPattern } from "./handlers/shared/azure-credential-store.js";
import { buildExternalIdParameterArnPattern } from "./handlers/shared/external-id-store.js";
import { buildGcpCredentialParameterArnPattern } from "./handlers/shared/gcp-credential-store.js";
import { buildSakuraCredentialParameterArnPattern } from "./handlers/shared/sakura-credential-store.js";

export interface CompetitorAccountsApiLambdaProps {
  /**
   * [Issue #2442 / Phase C2] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env
   * `COMPETITOR_ACCOUNTS_TABLE_NAME` は注入せず、grant も付与しない — CRUD / SAML config は
   * repository seam (`resolveCompetitorAccountsRepository` / `resolveSamlConfigRepository`)
   * が下記の Turso executor 配線経由で処理する。
   */
  readonly competitorAccountsTable?: Table;
  /** SSM SecureString path 構築用 (`/<env>/tenants/<tenantId>/external-id`)。 */
  readonly environmentName: string;
  /**
   * Issue #950: admin 操作 audit log 用 DDB Table。 deploy-api-lambda と同じ。
   */
  readonly adminAuditLogTable?: Table;
  /**
   * Issue #2311: 監査ログ feature flag。false で `AUDIT_LOG_ENABLED="false"` を注入し no-op 化。
   */
  readonly auditLogEnabled?: boolean;
  /**
   * Issue #2290: control-plane data backend (dynamodb|turso)。監査 Lambda 群と
   * lockstep で env を配線する。default (未指定 / `dynamodb`) は env を足さず byte 互換。
   */
  readonly controlDataBackend?: string;
  /**
   * [Issue #2442 / Phase C2] 本 Lambda が CompetitorAccounts CRUD + SAML config の repository
   * seam を実際に使う「DB を開く Lambda」なので、EventApi/GenericScoring と同じ Turso
   * executor 配線 (env + SSM GetParameter grant) を持つ。Public remote libSQL URL。
   */
  readonly tursoDatabaseUrl?: string;
  /** SSM SecureString parameter name containing the libSQL auth token. */
  readonly tursoAuthTokenParameterName?: string;
}

/**
 * Competitor Accounts API Lambda (Issue #459)。
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

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/competitor-accounts-handler/index.ts"),
      // verify endpoint は STS AssumeRole 1 回 (= ~1s) + DDB Update なので 10s で十分。
      timeout: Duration.seconds(15),
      // 256MB では init 中に Runtime.OutOfMemory で落ち、API Gateway が CORS ヘッダ無しの 502 を
      // 返すため、ブラウザには "Failed to fetch" としてしか見えなかった (競技者アカウント画面)。
      // 本番実測で init peak は ~676MB (Cognito SAML / STS / 複数 SDK client を eager load)。
      // 1024MB で余裕を持たせ、同時に CPU も増えて cold start が速くなる。
      memorySize: 1024,
      environment: {
        // Issue #2442: 純 SQL backend では table 自体が無いので env も足さない (= CFn byte
        // 互換 / DEPLOYMENTS_TABLE_NAME と同じ conditional-spread パターン)。
        ...(props.competitorAccountsTable
          ? { COMPETITOR_ACCOUNTS_TABLE_NAME: props.competitorAccountsTable.tableName }
          : {}),
        DEPLOY_ENVIRONMENT: props.environmentName,
        TENKACLOUD_ACCOUNT_ID: stack.account,
        // Issue #950: audit log table 名 (未配線なら空文字)
        ADMIN_AUDIT_LOG_TABLE_NAME: props.adminAuditLogTable?.tableName ?? "",
        // Issue #2311: 監査ログ feature flag (無効時のみ AUDIT_LOG_ENABLED="false" を注入)。
        ...auditLogEnabledEnv(props.auditLogEnabled),
        // Issue #2290: control-plane data backend (default dynamodb は env を足さず byte 互換)。
        ...controlDataBackendEnv(props.controlDataBackend ?? "dynamodb"),
        // [Issue #2442]: repository seam の Turso executor 接続情報 (default dynamodb では
        // props 自体が undefined = env を足さず byte 互換、EventApiLambda と同型の注入パターン)。
        ...(props.tursoDatabaseUrl ? { TURSO_DATABASE_URL: props.tursoDatabaseUrl } : {}),
        ...(props.tursoAuthTokenParameterName
          ? { TURSO_AUTH_TOKEN_PARAMETER_NAME: props.tursoAuthTokenParameterName }
          : {}),
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    // 1. DDB CompetitorAccounts: PutItem / Query / GetItem / UpdateItem / DeleteItem
    // Issue #2442: 純 SQL backend では table 自体が無いので grant も付与しない。
    props.competitorAccountsTable?.grantReadWriteData(this.fn);
    // Issue #950: admin audit log は write-only。
    props.adminAuditLogTable?.grantWriteData(this.fn);

    // 2. SSM Parameter Store SecureString — tenant の path prefix で絞り込み。
    //    `/{env}/tenants/*/external-id` (= tenantId は wildcard、env は固定)。
    const ssmArn = buildExternalIdParameterArnPattern(
      stack.region,
      stack.account,
      props.environmentName,
    );
    // [#1413] per-team cloud credential onboarding。 同 Lambda が TenantAdmin の
    // register/rotate/revoke で sakura/azure/gcp の SecureString を Put/Delete/Get する。 ExternalId と
    // 同じ prefix-scope (tenantId / teamSlug は wildcard) で最小権限を保つ。
    const credentialSsmArns = [
      ssmArn,
      buildSakuraCredentialParameterArnPattern(stack.region, stack.account, props.environmentName),
      buildAzureCredentialParameterArnPattern(stack.region, stack.account, props.environmentName),
      buildGcpCredentialParameterArnPattern(stack.region, stack.account, props.environmentName),
    ];
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"],
        resources: credentialSsmArns,
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
            "kms:EncryptionContext:PARAMETER_ARN": credentialSsmArns,
          },
        },
      }),
    );

    // [Issue #2442]: turso backend が Turso auth token を読むための SSM SecureString
    // read 権限。 未配線 (= dynamodb default) なら付与しない (`EventApiLambda` と同型)。
    if (props.tursoAuthTokenParameterName) {
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:${stack.partition}:ssm:${stack.region}:${
              stack.account
            }:parameter/${props.tursoAuthTokenParameterName.replace(/^\/+/, "")}`,
          ],
        }),
      );
    }

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
    //    #1391: 具体 UserPool ARN への scope は **不能**。 silo (PLATINUM) tenant の UserPool は
    //    provision-tenant.sh が per-tenant stack で動的に作るため、 この共有 Lambda の synth 時点では
    //    ARN を列挙できない (random pool-id、 命名 prefix も無い)。 よって `userpool/*` は
    //    アーキ上必須で、 越境防止の実効的な制御は IAM ではなく runtime の self-targeting guard
    //    (`extractUserPoolIdFromIss`、 = API GW JWT authorizer が署名検証した iss の pool だけを mutate)。
    //    guard の spoofing 耐性は tenant-saml.test.ts の adversarial cases で pin している。
    //    cross-stack で ARN を export すると TenantTemplateStack ↔ ProblemDeployBackendStack 間に
    //    CFn 循環依存が増えるトレードオフもある。
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
