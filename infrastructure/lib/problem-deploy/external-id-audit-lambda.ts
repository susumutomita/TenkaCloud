import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface ExternalIdAuditLambdaProps {
  /** `CompetitorAccounts` DDB table (rotatedAt / createdAt を読み取る)。 */
  readonly competitorAccountsTable: ITable;
  /**
   * CloudWatch メトリクスの `Environment` dimension 値。`development` / `staging` /
   * `production` (= `ProblemDeployBackendStack` の `environmentName` と同じ)。
   */
  readonly environmentName: string;
}

/**
 * Phase 3.2 / Issue #603: ExternalId rotation age 監査 Lambda。
 *
 * 1 日 1 回 EventBridge Scheduler (= `rate(1 day)`) から起動。CompetitorAccounts DDB を
 * 全件 Scan し、各行の `rotatedAt` (= 未 rotate なら `createdAt`) から経過した日数を
 * CloudWatch メトリクス `TenkaCloud/CompetitorAccounts/RotationAge` に publish する。
 *
 * **明示的な SSM version cleanup Lambda は作らない**:
 *   SSM Parameter Store は最新 100 version を auto-retain し、それ以上は自動 drop する。
 *   TenkaCloud の rotation cadence (= 四半期に 1 回程度) では 100 version cap に到達する
 *   現実が無いため、cleanup を Lambda で書く費用対効果は negative。代わりに「rotation
 *   していない tenant」を operator が CloudWatch Alarm で観察できる本 Lambda を入れる
 *   (Issue #603 の honest scope evaluation)。
 *
 * 必要権限:
 *   - DDB `CompetitorAccounts` 全行 Scan
 *   - CloudWatch `PutMetricData` (namespace を Condition で絞る)
 */
export class ExternalIdAuditLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: ExternalIdAuditLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/external-id-audit-handler/index.ts"),
      handler: "handler",
      // DDB Scan + PutMetricData 1 回。MVP 規模で 5s 以内に終わる想定だが余裕で 60s。
      timeout: Duration.seconds(60),
      memorySize: 256,
      environment: {
        COMPETITOR_ACCOUNTS_TABLE_NAME: props.competitorAccountsTable.tableName,
        DEPLOY_ENVIRONMENT: props.environmentName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node22",
        sourceMap: true,
        externalModules: [],
      },
    });

    // DDB Scan の権限 (CompetitorAccounts のみ)。Read のみ — 監査 lambda は write しない。
    props.competitorAccountsTable.grantReadData(this.fn);

    // CloudWatch PutMetricData。namespace を Condition で絞り、他 namespace に書けないようにする
    // (= 最小権限。`cloudwatch:Namespace` Condition は AWS が PutMetricData 入力から評価する)。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "cloudwatch:namespace": "TenkaCloud/CompetitorAccounts",
          },
        },
      }),
    );

    // 1 日 1 回起動。`Duration.days(1)` は EventBridge では `rate(1 day)` に展開される。
    new Rule(this, "Schedule", {
      schedule: Schedule.rate(Duration.days(1)),
      description:
        "TenkaCloud ExternalId rotation age audit (Phase 3.2 / Issue #603): 1 日 1 回 CompetitorAccounts を Scan し RotationAge metric を emit。",
      targets: [new LambdaFunction(this.fn)],
    });
  }
}
