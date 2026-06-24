import * as path from "node:path";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import type { IUserPool } from "aws-cdk-lib/aws-cognito";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import {
  LAMBDA_NODEJS_BUNDLING_TARGET,
  LAMBDA_NODEJS_RUNTIME,
  LAMBDA_SOURCE_MAP_ENABLED,
} from "../utils/lambda-runtime.js";

export interface SamlIdpLambdaProps {
  /**
   * Issue #1312: per-tenant SAML IdP CRUD 用の DDB Table。 PK=`pk` (scope) / SK=`sk` (idpId)。
   * Handler 側 `createDdbIdpStore` の Key 名と一致させること。
   */
  readonly samlIdpsTable: Table;
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
 */
export class SamlIdpLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: SamlIdpLambdaProps) {
    super(scope, id);
    const stack = Stack.of(this);

    this.fn = new NodejsFunction(this, "Function", {
      logGroup: new LogGroup(this, "FunctionLogGroup", {
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      runtime: LAMBDA_NODEJS_RUNTIME,
      architecture: Architecture.ARM_64,
      entry: path.resolve(import.meta.dirname, "../tenant-template/handlers/idp-handler/index.ts"),
      handler: "handler",
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        SAML_IDPS_TABLE_NAME: props.samlIdpsTable.tableName,
        TENANT_USER_POOL_ID: props.userPool.userPoolId,
        IDP_TIER_GUARD: props.idpTierGuard,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: LAMBDA_NODEJS_BUNDLING_TARGET,
        sourceMap: LAMBDA_SOURCE_MAP_ENABLED,
        externalModules: [],
      },
    });

    // DDB: 全 CRUD 経路 (list / get / put / delete) で R+W が必要。
    props.samlIdpsTable.grantReadWriteData(this.fn);

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
