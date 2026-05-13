import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { grantChallengePayloadRead } from "../utils/iam-helpers.js";
import { buildExternalIdParameterArnPattern } from "./handlers/shared/external-id-store.js";

export interface DeployApiLambdaProps {
  readonly deploymentsTable: Table;
  readonly eventBus: IEventBus;
  /**
   * Phase 2.2 (Issue #459): single-deploy / stack-progress が verified=true 行のみ
   * 許可する gate のため、CompetitorAccounts table を Read する。
   */
  readonly competitorAccountsTable: Table;
  /**
   * tenantId として handler に渡す `DEFAULT_TENANT_ID` env。Cognito JWT authorizer
   * 結線後は JWT claim から取るが、Function URL 直叩き / dev / unit test では本値を使う。
   */
  readonly defaultTenantId?: string;
  /**
   * `problemId → problemDir` の hard-coded 問題カタログ (MVP-1)。
   * tenant API Lambda が POST /problems/:id/deploy を受けたとき、引数の problemId から
   * `problems/<category>/<id>` 形式の path を解決し、Step Functions State Machine の
   * 入力 (`detail.problemDir`) に詰める。Phase 2 (ADR-003) で DDB ベースの catalog に置換。
   */
  readonly problemsCatalog: Readonly<Record<string, string>>;
  /**
   * ADR-008 Phase 3 (Issue #642): private 問題 id のセット (= `{problemId: "private"}`)。
   * `discoverProblemsVisibility` の戻り値そのまま。 空 map なら全 public 扱いで dormant。
   */
  readonly problemsVisibility: Readonly<Record<string, "private">>;
  /**
   * ADR-008 Phase 3 (Issue #642): private 問題 payload を格納する S3 bucket 名。
   * 未指定 / 空文字列なら presigned URL を発行しない (= local-path 経路で動作)。
   * ChallengePayloadStack (Phase 2 infra) が deploy 後にここを指定して活性化する。
   */
  readonly challengePayloadBucketName?: string;
  /**
   * SSM SecureString path 構築用の env 名 (Phase 2.2、`/<environmentName>/tenants/...`)。
   */
  readonly environmentName: string;
}

/**
 * 問題 deploy 起動用 Lambda。
 *
 * MVP-1 (ADR-001 PR-2): tenant API (TenantTemplateStack の REST API + Cognito authorizer)
 * から `LambdaIntegration` で invoke され、validation 後に EventBridge へ
 * `DeployCreateRequested` event を publish する。実 deploy は EventBridge Rule から
 * Step Functions State Machine + CodeBuild が肩代わりする。
 *
 * Function URL は付けない (旧 MVP-0 の AWS_IAM 経路は廃止)。
 */
export class DeployApiLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: DeployApiLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/deploy-handler/index.ts"),
      handler: "handler",
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName,
        // Phase 2.2 (Issue #459)
        COMPETITOR_ACCOUNTS_TABLE_NAME: props.competitorAccountsTable.tableName,
        DEPLOY_ENVIRONMENT: props.environmentName,
        DEPLOY_EVENT_BUS_NAME: props.eventBus.eventBusName,
        // #686: legacy "unknown-tenant" fallback は削除 (= JWT claim 欠落時は handler が 401)
        ...(props.defaultTenantId ? { DEFAULT_TENANT_ID: props.defaultTenantId } : {}),
        BATTLE_PROBLEMS_CATALOG: JSON.stringify(props.problemsCatalog),
        // ADR-008 Phase 3 (Issue #642): visibility + bucket env、 default は dormant
        BATTLE_PROBLEMS_VISIBILITY: JSON.stringify(props.problemsVisibility),
        CHALLENGE_PAYLOAD_BUCKET: props.challengePayloadBucketName ?? "",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node20",
        sourceMap: true,
        externalModules: [],
      },
    });

    // 必要な権限: DDB CRUD + EventBus PutEvents + CompetitorAccounts Read。
    // Phase 2.2 (Issue #459): verified-only gate のために CompetitorAccounts は read-only で
    // 引く。AssumeRole / SSM SecureString は CompetitorAccountsApiLambda + State Machine 経由
    // (= 本 Lambda は同期 API 経路のみ担う)。
    props.deploymentsTable.grantReadWriteData(this.fn);
    props.competitorAccountsTable.grantReadData(this.fn);
    props.eventBus.grantPutEventsTo(this.fn);

    // #534: deploy job 詳細ページから CFn StackEvents / StackResources を引く読み取り権限。
    // same-account 経路 (= dev / 旧 deployment 行) では本 Lambda Role が直接呼ぶため Describe*
    // を ALLOW する。Phase 2.2 (Issue #459) の cross-account では AssumeRole 経由になるが、
    // verified=true 行が無いケースで fallback として残るので削除しない。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudformation:DescribeStackEvents", "cloudformation:DescribeStackResources"],
        resources: ["*"],
      }),
    );

    // Phase 2.2 (Issue #459): stack-progress の cross-account 経路で必要な権限。
    //   - SSM SecureString Read (= tenant path prefix scope)
    //   - kms:Decrypt (= SSM SecureString 復号、AWS managed key + EncryptionContext で絞る)
    //   - sts:AssumeRole (= 競技者 IAM Role `TenkaCloud-*`)
    // CompetitorAccountsApiLambda と同じ pattern (= 最小権限 + path prefix scope)。
    const stack = Stack.of(this);
    const ssmArn = buildExternalIdParameterArnPattern(
      stack.region,
      stack.account,
      props.environmentName,
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [ssmArn],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringLike: { "kms:EncryptionContext:PARAMETER_ARN": ssmArn },
        },
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: ["arn:aws:iam::*:role/TenkaCloud-*"],
      }),
    );

    // ADR-008 Phase 3 (Issue #642): private 問題 payload の S3 GetObject 権限。
    // bucket 未指定なら no-op (= dormant、 最小権限維持)。
    grantChallengePayloadRead(this, this.fn, props.challengePayloadBucketName);
  }
}
