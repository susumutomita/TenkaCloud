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
   * Events table。Event status の auto-transition (#557 / #539) を 1-min tick で reconcile する。
   * uptime 採点とは独立の責務だが、cron schedule (= rate(1 minute)) を共有することで
   * Lambda 数 / EventBridge rule 数を抑える (Free Tier 維持)。
   */
  readonly eventsTable: ITable;
  /**
   * `{ [problemId]: scoring }` 形の scoring 設定。`uptime` 形式の問題のみが probe 対象。
   */
  readonly problemsScoring: Readonly<Record<string, unknown>>;
}

/**
 * 1 分間隔で 2 つの reconcile 処理を回す Lambda:
 *
 * 1. **uptime 採点** (`scoring.kind=uptime` の問題のみ): Deployments DDB を scan し
 *    `status=COMPLETE` 行の endpoints を probe、成功なら `score += pointsPerSuccess`。
 *    MVP-1 規模 (~50 deployments) は Scan + FilterExpression で十分。Phase 2 で 100+ に
 *    なったら GSI3 (PK=STATUS#{status}) を追加して Query 化する。
 * 2. **Event status auto-transition** (#557 #539): Events DDB を scan し `DEPLOYING` /
 *    `TEARDOWN` 状態の Event について子 deployments の集約 status を見て `READY` /
 *    `ARCHIVED` に遷移。子 deployment が全 terminal で初めて遷移する設計。
 *
 * 両方とも EventBridge `rate(1 minute)` で起動。互いに依存なし (= 別 table / 別 row)
 * なので Promise.all で並列実行できる。
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
        EVENTS_TABLE_NAME: props.eventsTable.tableName,
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
    // Events table も同様: Scan で DEPLOYING / TEARDOWN 行を拾い、ConditionExpression 付き
    // UpdateItem で次状態 (READY / ARCHIVED) に遷移させる (#557 #539)。
    props.eventsTable.grantReadWriteData(this.fn);

    // EventBridge `rate(1 minute)`. Lambda 自身に invoke 権限は LambdaFunction target が
    // 自動付与する。
    new Rule(this, "Schedule", {
      schedule: Schedule.rate(Duration.minutes(1)),
      description: "TenkaCloud 1-min tick: uptime scoring + Event status reconcile (#557 #539).",
      targets: [new LambdaFunction(this.fn)],
    });
  }
}
