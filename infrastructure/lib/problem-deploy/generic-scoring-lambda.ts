import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface GenericScoringLambdaProps {
  readonly deploymentsTable: ITable;
  /**
   * Events table。Event status の auto-transition (#557 / #539) を 1-min tick で reconcile する。
   * 採点 dispatcher とは独立の責務だが、 cron schedule (= rate(1 minute)) を共有する。
   */
  readonly eventsTable: ITable;
  /**
   * ADR-012 Phase 3.A: Endpoint registry table (= ProblemEndpoints)。 dispatcher は
   * per (tenant, team, problem) で override 行を Query で引き、 effective URL (= override ?? default)
   * を probe する。
   */
  readonly endpointsTable: ITable;
  /**
   * `{ [problemId]: scoring }` 形の 5 種 builtin scoring 設定 (ADR-012 Phase 3.B)。
   * `scoring` field を持たない問題は不在キー (= 採点無効)。
   */
  readonly problemsScoring: Readonly<Record<string, unknown>>;
  /**
   * ADR-012 Phase 3.A: `{ [problemId]: ProblemEndpointSlot[] }`。dispatcher が
   * default URL (= CFn output から read-through) を解決するため参照。`endpoints[]`
   * 宣言の無い問題は不在キー。
   */
  readonly problemsEndpoints: Readonly<Record<string, unknown>>;
  /**
   * `{ [problemId]: PhaseEntry[] }`。 `phased-polling` kind 用の phase 定義。 metadata.phases[]
   * を持たない問題は不在キー。
   */
  readonly problemsPhases: Readonly<Record<string, unknown>>;
}

/**
 * ADR-012 Phase 3.B: Generic scoring Lambda (旧 HealthCheckLambda の後継)。
 *
 * 1 分間隔で 2 つの reconcile 処理を回す:
 *
 * 1. **採点 dispatch** (= 5 種 builtin kind): Deployments DDB を scan し `status=COMPLETE`
 *    な行について `metadata.scoring.kind` を dispatch して採点する。
 *    - flag (= polling 越しでは no-op、 submit-flag が扱う)
 *    - uptime-flat / uptime (legacy alias)
 *    - uptime-multi
 *    - phased-polling
 *    - attack-detection
 *
 * 2. **Event status auto-transition** (#557 #539): Events DDB を scan し `DEPLOYING` /
 *    `TEARDOWN` 状態の Event を子 deployment 集約 status で `READY` / `ARCHIVED` に遷移。
 *
 * 両方とも EventBridge `rate(1 minute)` で起動。 両 reconcile は別 table / 別 row で独立し、
 * `Promise.all` で並列実行する。
 *
 * 旧 `HealthCheckLambda` (= `health-check-handler/index.ts`) の責務を完全に引き継ぐ
 * (= hello-world-battle 等の既存挙動 unchanged)。違いは scoring kind が 5 種に拡張された
 * 点と、 endpoint resolution が Phase 3.A の override registry を参照する点のみ。
 */
export class GenericScoringLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: GenericScoringLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/generic-scoring-handler/index.ts"),
      handler: "handler",
      timeout: Duration.minutes(2),
      // #746: 旧 256MB だと cold start で OOM + init timeout が頻発し採点 Lambda が
      // 起動すらしなかった (CloudWatch logs で Init Duration 10001ms timeout +
      // Runtime.OutOfMemory を確認)。 同 ParticipantPortalLambda が #672 で 512MB に
      // 上げた経緯と同じく、 bundle が AWS SDK / Hono / zod 込みで巨大なので 1024MB に
      // 余裕を持たせる (= cold start 後の steady state は実測 256MB 未満で済むはず)。
      memorySize: 1024,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName,
        EVENTS_TABLE_NAME: props.eventsTable.tableName,
        PROBLEM_ENDPOINTS_TABLE_NAME: props.endpointsTable.tableName,
        BATTLE_PROBLEMS_SCORING: JSON.stringify(props.problemsScoring),
        PROBLEM_ENDPOINTS: JSON.stringify(props.problemsEndpoints),
        BATTLE_PROBLEMS_PHASES: JSON.stringify(props.problemsPhases),
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node22",
        sourceMap: true,
        externalModules: [],
      },
    });

    // Lambda が deployments table を Scan + UpdateItem できるよう許可 (= 採点 score 加算 +
    // endpointsHealth / scoringState 更新)。
    props.deploymentsTable.grantReadWriteData(this.fn);
    // Events table: Scan で DEPLOYING / TEARDOWN 行を拾い、 conditional UpdateItem で
    // READY / ARCHIVED に遷移させる (#557 #539)。 BatchGet で scoringLocked も読む (#558)。
    props.eventsTable.grantReadWriteData(this.fn);
    // Endpoint registry: per (tenant, team, problem) の override 行を Query する (= read-only)。
    props.endpointsTable.grantReadData(this.fn);

    // EventBridge `rate(1 minute)`. Lambda 自身の invoke 権限は LambdaFunction target が自動付与。
    new Rule(this, "Schedule", {
      schedule: Schedule.rate(Duration.minutes(1)),
      description:
        "TenkaCloud 1-min tick: ADR-012 generic scoring dispatcher + Event status reconcile (#557 #539).",
      targets: [new LambdaFunction(this.fn)],
    });
  }
}
