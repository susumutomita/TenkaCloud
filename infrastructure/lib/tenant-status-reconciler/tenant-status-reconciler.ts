import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface TenantStatusReconcilerProps {
  /**
   * Reconciliation 対象の TenantMappingTable。 Lambda は本テーブルを scan + update する。
   */
  readonly tenantMappingTable: ITable;
  /**
   * 実行周期。 default 2 分。 RCU を抑えたければ伸ばす。
   */
  readonly scheduleInterval?: Duration;
}

/**
 * Issue #659: TenantMappingTable の "In progress" stuck 状態を自動遷移させる Reconciler。
 *
 * EventBridge Schedule (= default 2 分) で Lambda を起動し、 各 row を `decideReconcile()`
 * policy で評価。 tenantConfig に CFn output が JSON 書き戻されていれば "Complete"、
 * 60 分超で未充足なら "Failed" + failureReason に置く。
 *
 * SBT pipeline event 直接 listen 経路は採用していない (= 1 execution が複数 tenant を
 * batch 処理するため 1:1 mapping が取れない)。 CFn output 経由の indirection で
 * conservative かつ正確 (= bash 完了 = 安定状態) に判定する。
 */
export class TenantStatusReconciler extends Construct {
  public readonly fn: NodejsFunction;
  public readonly rule: Rule;

  constructor(scope: Construct, id: string, props: TenantStatusReconcilerProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/handler.ts"),
      handler: "handler",
      timeout: Duration.seconds(60),
      memorySize: 256,
      environment: {
        TENANT_MAPPING_TABLE_NAME: props.tenantMappingTable.tableName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node22",
        sourceMap: true,
        externalModules: [],
      },
    });
    props.tenantMappingTable.grantReadWriteData(this.fn);

    this.rule = new Rule(this, "Schedule", {
      schedule: Schedule.rate(props.scheduleInterval ?? Duration.minutes(2)),
      targets: [new LambdaFunction(this.fn)],
    });
  }
}
