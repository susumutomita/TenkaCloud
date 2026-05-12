import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface AdminInsightApiLambdaProps {
  /**
   * 問題 deploy 状況 (active / failed 集計) の出元。`ProblemDeployBackendStack` の
   * `Deployments` table を cross-stack 参照する。Read-only (= ADR-011 D6 Phase 1 は read-only)。
   */
  readonly deploymentsTable: Table;
  /**
   * 競技 Event 総数の出元。`ProblemDeployBackendStack` の `Events` table を cross-stack 参照する。
   * Read-only。
   */
  readonly eventsTable: Table;
  /**
   * Phase 1.B 以降の drill-down 拡張 (team 別 / event 詳細) で読み取り対象になる Teams table。
   * Phase 1.A では env として注入のみ行い、read 権限は付与しない (= 最小権限)。
   */
  readonly teamsTable: Table;
}

/**
 * Admin Insight API Lambda (ADR-011 / issue #590 Phase 1.A)。
 *
 * System Admin が admin-console から cross-tenant に deploy 進捗を見る経路。
 * tenant 専用 Lambda (= DeployApi / EventApi) と分離して認可境界を明確にする (ADR-011 D1 採用案)。
 *
 * routes (Phase 1.A):
 *   GET /admin/insight/tenants/summary?tenantIds=t1,t2,t3
 *     → per-tenant の activeDeploys / failedDeploys / totalEvents 集計
 *
 * Auth: 呼び出し側の AdminConsoleInsightStack で HTTP API + JWT Authorizer (ControlPlane
 * UserPool) を結線する。Handler は更に `cognito:groups` ⊇ {SystemAdmin} の claim 検査を行う。
 */
export class AdminInsightApiLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: AdminInsightApiLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/admin-insight-handler/index.ts"),
      handler: "handler",
      // Per-tenant Query を Promise.all で並列発火するので、tenant 数 100 件 × DDB 往復 ~50ms
      // ≒ 5s が最大。安全側で 15s。
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName,
        EVENTS_TABLE_NAME: props.eventsTable.tableName,
        TEAMS_TABLE_NAME: props.teamsTable.tableName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node20",
        sourceMap: true,
        externalModules: [],
      },
    });

    // ADR-011 Phase 1 D6: read-only に限定。Deployments / Events への read のみ grant し、
    // Teams は Phase 1.B 以降で drill-down が要るときに read 追加する。
    // GSI も含めて read できる必要があるので grantReadData (= GetItem / Query / Scan + index)
    // を使う (= 個別 PolicyStatement で限定するより SBT 同型の grantRead で十分)。
    props.deploymentsTable.grantReadData(this.fn);
    props.eventsTable.grantReadData(this.fn);
  }
}
