import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface MicroserviceMigrationPollerLambdaProps {
  readonly scoresTable: ITable;
  /**
   * `Deployments` DDB。本 Lambda は GSI1 を Query して tenant の jobId / createdAt /
   * eventId / expiresAt を取得し、ScoreEvent (= sparse EVENT 行) を Put する。
   */
  readonly deploymentsTable: ITable;
  /**
   * EC2 劣化フェーズ突入までの分数 (`degradationMinutes` env)。default 60。
   * EC2 score が +100 → +10 に切り替わる閾値。問題 `template.yaml` の cron 設定とは
   * 独立 (= operator が runtime で本 env を上書きしても EC2 側 cron は事前に焼かれた値)。
   */
  readonly degradationMinutes?: number;
  /**
   * `/score` → `/score?legacy=true` 切替までの分数 (`legacySwitchMinutes` env)。default 90。
   * 競技者が legacy code path (= 意図的 sleep) を取り除いて再デプロイすることを促す閾値。
   */
  readonly legacySwitchMinutes?: number;
}

const DEFAULT_DEGRADATION_MINUTES = 60;
const DEFAULT_LEGACY_SWITCH_MINUTES = 90;

/**
 * Microservice Migration Battle (Phase 2 / Issue #606) の 1 min polling Lambda。
 *
 * EventBridge `rate(1 minute)` で起動 (= 既存 `HealthCheckLambda` と同 pattern)。本 Lambda は
 * `health-check-handler` とは別系統で持つ:
 *   - health-check は `scoring.kind=uptime` 用に declared endpoints (`stackOutputs[outputKey]`) を probe
 *   - 本 Lambda は競技者が動的に登録した URL (= microservice-migration scores table) を probe
 *
 * 責務分離理由:
 *   - 採点ルールが完全に違う (= platform 別 + phase 別 + bonus)。同居させると scoring.ts の責任が肥大化
 *   - 本問題の polling は 3 slot per tenant の small dataset。health-check は全 deployment scan で
 *     I/O profile が違う (= cron スケジュールも将来分離可能)
 *
 * ScoreEvent は `writeScoreEvent` 経由で Deployments table に書く (= 既存の Battle Portal /
 * leaderboard と整合)。`source=microservice-migration` / `microservice-migration-bonus` を区別。
 */
export class MicroserviceMigrationPollerLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: MicroserviceMigrationPollerLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/microservice-migration-poller-handler/index.ts"),
      handler: "handler",
      timeout: Duration.minutes(2),
      memorySize: 256,
      environment: {
        MICROSERVICE_MIGRATION_SCORES_TABLE_NAME: props.scoresTable.tableName,
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName,
        MICROSERVICE_MIGRATION_DEGRADATION_MINUTES: String(
          props.degradationMinutes ?? DEFAULT_DEGRADATION_MINUTES,
        ),
        MICROSERVICE_MIGRATION_LEGACY_SWITCH_MINUTES: String(
          props.legacySwitchMinutes ?? DEFAULT_LEGACY_SWITCH_MINUTES,
        ),
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node20",
        sourceMap: true,
        externalModules: [],
      },
    });

    // 観測列を上書きする + bonus sentinel を立てるため scores table は RW。
    props.scoresTable.grantReadWriteData(this.fn);
    // Deployments table は ScoreEvent を Put + GSI1 を Query する (= RW 必要)。
    // (Put 自体は新 sparse EVENT row を足すだけ、META 行は触らない)
    props.deploymentsTable.grantReadWriteData(this.fn);

    // EventBridge rate(1 minute) の独立 Rule (= HealthCheck と共有しない、責務分離)。
    new Rule(this, "Schedule", {
      schedule: Schedule.rate(Duration.minutes(1)),
      description:
        "TenkaCloud 1-min tick: Microservice Migration Battle (Phase 2 / #606) scoring poller.",
      targets: [new LambdaFunction(this.fn)],
    });
  }
}
