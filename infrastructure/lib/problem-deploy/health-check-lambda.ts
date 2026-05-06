import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface HealthCheckLambdaProps {
  readonly deploymentsTable: ITable;
  /**
   * `{ [problemId]: scoring }` 形の scoring 設定。`uptime` 形式の問題のみが probe 対象。
   */
  readonly problemsScoring: Readonly<Record<string, unknown>>;
}

/**
 * 問題が deploy された後、定期的にエンドポイントを probe してスコアを加減する Lambda。
 *
 * EventBridge `rate(1 minute)` で定期起動され、Deployments DDB を scan して
 * `status=COMPLETE` の各 deployment について metadata の `scoring.kind=uptime` を
 * 確認、declared endpoints を fetch し、すべて 2xx (or expectStatus) なら
 * `score += pointsPerSuccess`、失敗なら `lastResult=fail` のみ更新する。
 *
 * MVP-1 規模 (~50 deployments) は Scan + FilterExpression で十分。Phase 2 で
 * 100+ になったら GSI3 (PK=STATUS#{status}) を追加して Query 化する。
 */
export class HealthCheckLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: HealthCheckLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/health-check-handler/index.ts"),
      handler: "handler",
      timeout: Duration.minutes(2),
      memorySize: 256,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName,
        BATTLE_PROBLEMS_SCORING: JSON.stringify(props.problemsScoring),
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node20",
        sourceMap: true,
        externalModules: [],
      },
    });

    // Lambda が deployments table を Scan + UpdateItem できるよう許可。
    props.deploymentsTable.grantReadWriteData(this.fn);

    // EventBridge `rate(1 minute)`. Lambda 自身に invoke 権限は LambdaFunction target が
    // 自動付与する。
    new Rule(this, "Schedule", {
      schedule: Schedule.rate(Duration.minutes(1)),
      description: "TenkaCloud uptime scoring health check (1 minute interval).",
      targets: [new LambdaFunction(this.fn)],
    });
  }
}
