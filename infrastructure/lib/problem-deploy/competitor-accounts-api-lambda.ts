import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { buildExternalIdParameterArnPattern } from "./handlers/shared/external-id-store.js";

export interface CompetitorAccountsApiLambdaProps {
  readonly competitorAccountsTable: Table;
  /** SSM SecureString path 構築用 (`/<env>/tenants/<tenantId>/external-id`)。 */
  readonly environmentName: string;
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
      runtime: Runtime.NODEJS_20_X,
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
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node20",
        sourceMap: true,
        externalModules: [],
      },
    });

    // 1. DDB CompetitorAccounts: PutItem / Query / GetItem / UpdateItem / DeleteItem
    props.competitorAccountsTable.grantReadWriteData(this.fn);

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
    // 復号には KMS Decrypt 権限が要る。AWS managed key の Resource ARN は account/region から
    // 構築できないので、`Encryption Context: PARAMETER_ARN` で絞り込む。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["kms:Decrypt", "kms:Encrypt"],
        // Resource は `*` だが Condition で SSM context に限定 (= AWS managed key のみ実質効く)。
        resources: ["*"],
        conditions: {
          StringEquals: {
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
  }
}
