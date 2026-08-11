import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import type { IUserPool } from "aws-cdk-lib/aws-cognito";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";
import { controlDataBackendEnv } from "./control-data-backend-env.js";

export interface SamlIdpLambdaProps {
  /**
   * Issue #1312: per-tenant SAML IdP CRUD 用の DDB Table。 PK=`pk` (scope) / SK=`sk` (idpId)。
   * Handler 側 `createSeamIdpStore` の Key 名と一致させること。
   *
   * [Issue #2442 / Phase C5] `controlDataBackend` が純 SQL (`turso`) のときは
   * `TenkaCloudLiteStack` が本 table を synth しない (= `undefined`)。 その場合 env
   * `SAML_IDPS_TABLE_NAME` は注入せず grant も付与しない — IdP CRUD は repository seam
   * (`createSeamIdpStore` → `resolveSamlIdpsRepository`) が下記の Turso executor 配線経由で
   * 処理する (本 Lambda 自身が「DB を開く Lambda」)。
   */
  readonly samlIdpsTable?: Table;
  /**
   * Tenant UserPool。 handler は `TENANT_USER_POOL_ID` env で受け、 cognito-adapter が
   * `CreateIdentityProvider` / `UpdateIdentityProvider` 等を本 UserPool に対して mutate する。
   * Lite mode は 1 tenant 専用 (= silo 同型) のため本 stack 内で同 UserPool を直接渡す
   * (= cross-stack ref を作らず cyclic dependency を避ける)。
   */
  readonly userPool: IUserPool;
  /**
   * Lite mode は 1 tenant 専用 (tenantId=local) で UserPool も silo 同型なので、
   * 配線時に `"silo"` 固定。 pooled 配線時に誤って動くと cross-tenant 副作用が出るため、
   * handler 側で env 値が `"silo"` 以外なら 503 を返す fail-closed guard を持つ
   * (= `infrastructure/lib/tenant-template/handlers/idp-handler/index.ts`)。
   */
  readonly idpTierGuard: "silo";
  /**
   * Issue #2290: control-plane data backend (dynamodb|turso)。他の C-series
   * Lambda 群と lockstep で env を配線する。default (未指定 / `dynamodb`) は env を足さず byte 互換。
   */
  readonly controlDataBackend?: string;
  /**
   * [Issue #2442 / Phase C5] Public remote libSQL URL。本 Lambda は `createSeamIdpStore` を通じて
   * SamlIdps repository seam を実際に使う「DB を開く Lambda」なので Turso executor 配線を持つ
   * (SystemAuditWriter/CompetitorAccountsApi と同型)。
   */
  readonly tursoDatabaseUrl?: string;
  /** SSM SecureString parameter name containing the libSQL auth token. */
  readonly tursoAuthTokenParameterName?: string;
}

/**
 * Issue #1312: Application Plane SAML IdP CRUD Lambda (= tenant-template/handlers/idp-handler/index.ts)。
 *
 * Lite mode (= TenkaCloudLiteStack 内) で UserPool と同 stack に配置する。 cross-stack で
 * `TENANT_USER_POOL_ID` を渡そうとすると ProblemDeploy → Lite UserPool の逆方向参照になり
 * `addDependency` cycle になるため、 同 stack 内 instantiation を選ぶ。
 *
 * `competitor-accounts-api-lambda.ts` の Cognito IAM grant と同じ pattern (= account / region 配下の
 * userpool/* に wildcard で grant、 runtime guard は `TENANT_USER_POOL_ID` env で 自 pool を絞る)。
 *
 * SAML CRUD は admin 操作のみで極低 QPS / 短時間で済むため、 timeout 30s / memory 512MB で十分。
 *
 * [Issue #2442 / Phase C5] `samlIdpsTable` が無い (= 純 SQL backend) 場合でも本 Lambda 自体は常に
 * 生成される — Lite mode は `controlDataBackend` の値に関わらず IdP CRUD API を提供し続ける契約
 * (`TenkaCloudLiteStack` が `attachSamlIdpLambda: true` を常に渡す)。 table の有無だけが env/grant を
 * 条件化する。
 */
export class SamlIdpLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: SamlIdpLambdaProps) {
    super(scope, id);
    const stack = Stack.of(this);

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "../tenant-template/handlers/idp-handler/index.ts"),
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        // [Issue #2442] 純 SQL backend では table 自体が無いので env も足さない。
        ...(props.samlIdpsTable ? { SAML_IDPS_TABLE_NAME: props.samlIdpsTable.tableName } : {}),
        TENANT_USER_POOL_ID: props.userPool.userPoolId,
        IDP_TIER_GUARD: props.idpTierGuard,
        // Issue #2290: control-plane data backend (default dynamodb は env を足さず byte 互換)。
        ...controlDataBackendEnv(props.controlDataBackend ?? "dynamodb"),
        ...(props.tursoDatabaseUrl ? { TURSO_DATABASE_URL: props.tursoDatabaseUrl } : {}),
        ...(props.tursoAuthTokenParameterName
          ? { TURSO_AUTH_TOKEN_PARAMETER_NAME: props.tursoAuthTokenParameterName }
          : {}),
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    // DDB: 全 CRUD 経路 (list / get / put / delete) で R+W が必要。
    // [Issue #2442] 純 SQL backend では table 自体が無いので grant も付与しない。
    props.samlIdpsTable?.grantReadWriteData(this.fn);

    // [Issue #2442]: turso backend が Turso auth token を読むための SSM SecureString
    // read 権限。 未配線 (= dynamodb default) なら付与しない (`SystemAuditWriterLambda` と同型)。
    if (props.tursoAuthTokenParameterName) {
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter/${props.tursoAuthTokenParameterName.replace(/^\/+/, "")}`,
          ],
        }),
      );
    }

    // Cognito IdP CRUD: 同 account / region 配下の任意 UserPool に対して allow。
    // 実 UserPool は runtime で `TENANT_USER_POOL_ID` env 経由の `userPoolId` (cognito-adapter) で
    // 絞り込まれる。 IAM resource は具体 UserPool ARN ではなく wildcard、 自 pool 絞り込みは
    // runtime guard (= competitor-accounts-api-lambda.ts と同 pattern)。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "cognito-idp:CreateIdentityProvider",
          "cognito-idp:UpdateIdentityProvider",
          "cognito-idp:DescribeIdentityProvider",
          "cognito-idp:DeleteIdentityProvider",
          "cognito-idp:ListIdentityProviders",
        ],
        resources: [`arn:aws:cognito-idp:${stack.region}:${stack.account}:userpool/*`],
      }),
    );
  }
}
