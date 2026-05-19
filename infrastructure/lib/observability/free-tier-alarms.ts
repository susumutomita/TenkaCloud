import { Duration } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
  Unit,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import type { ITopic } from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

/**
 * Issue #952 epic / コスト爆発防止: AWS Free Tier breach 検知 CloudWatch Alarms。
 *
 * 旧状態: `CostBudget` construct で月次 USD 上限 alarm は持つ (= AWS Budgets)。 これは
 * **金額 base** の遅延 alarm (= 24-48h 遅れ)、 spike を即座に検知できない。 sudden traffic
 * (= 攻撃 / runaway loop / 設定ミス) は数時間で Free Tier を吹き飛ばす。
 *
 * 本 construct は **resource usage base** の即時 alarm を立てる:
 *
 *   - Lambda: 月次 invocations が Free Tier の 80% (= 800k req) に達したら alarm
 *   - DynamoDB: 月次 ConsumedReadCapacityUnits / WriteCapacityUnits が Free Tier (= 25 RCU/WCU)
 *     を超過したら alarm (= DynamoDbLowCapacity Aspect で 1/1 PROVISIONED に強制してあるので
 *     通常超過しないが、 hand-edit / future stack 追加で破られた場合の defense-in-depth)
 *
 * 各 alarm は SNS topic に publish。 caller (= ObservabilityStack) は CostBudget と同じ
 * topic を渡す想定 (= operator email に統一)。
 *
 * 設計:
 *   - Alarm 自体は **無料** (= AWS CloudWatch Standard alarm 10 個までは Free Tier 内)
 *   - SNS 通知は 1,000 件まで free
 *   - 集計 period は 1 日 (= 月次 cap の 1/30) で計算、 80% 閾値を sum で判定
 */

export interface FreeTierAlarmsProps {
  /** 通知先 SNS topic (= CostBudget と共有を推奨)。 */
  readonly notificationTopic: ITopic;
  /**
   * monitor 対象の Lambda function 名一覧。 各 function に対して invocations + errors alarm を
   * 立てる。 全部の合計を 1 つの alarm にする方が安いが、 どの function が暴走したかが見えない
   * ので個別に立てる。
   */
  readonly lambdaFunctionNames: readonly string[];
  /**
   * monitor 対象の DDB Table 名一覧。 ConsumedReadCapacityUnits / WriteCapacityUnits を見る。
   */
  readonly dynamoDbTableNames: readonly string[];
  /**
   * #1080: monitor 対象の API Gateway (HTTP / REST 混在) のリスト。 5XX rate alarm を立てる。
   */
  readonly apiGateways?: readonly ApiGatewayAlarmTarget[];
  /**
   * Lambda 月次 invocation Free Tier (= 1M req)、 80% を default 閾値とする。
   * 日次に分割すると 800,000 / 30 ≒ 26,666 inv/day。 1 alarm 期間 = 1 day。
   */
  readonly lambdaDailyInvocationThreshold?: number;
  /**
   * Lambda 日次 errors alarm 閾値 (#1080)。 1 日に N 件超のエラーで通知。
   * バグ / 設定ミス / 外部依存障害の早期検知が目的。
   */
  readonly lambdaDailyErrorsThreshold?: number;
  /**
   * DDB Free Tier (= 25 RCU/WCU per Table) の超過検知。 PROVISIONED 1/1 を強制している
   * (DynamoDbLowCapacity Aspect) ので通常 1 RCU * 86400 sec/day = 86,400 が日次理論上限、
   * 余裕を 100,000 にする。
   */
  readonly dynamoDbDailyConsumedThreshold?: number;
  /**
   * API Gateway の日次 5XX 件数 alarm 閾値 (#1080)。
   */
  readonly apiGateway5xxDailyThreshold?: number;
}

export type ApiGatewayAlarmTarget =
  | {
      readonly kind: "http";
      readonly label: string;
      readonly apiId: string;
      readonly stage?: string;
    }
  | {
      readonly kind: "rest";
      readonly label: string;
      readonly apiName: string;
      readonly stage?: string;
    };

const DEFAULT_LAMBDA_DAILY_INVOCATIONS = 26_666; // 800k/month / 30 days
const DEFAULT_LAMBDA_DAILY_ERRORS = 50;
const DEFAULT_DDB_DAILY_CONSUMED = 100_000;
const DEFAULT_API_GATEWAY_5XX_DAILY = 50;

export class FreeTierAlarms extends Construct {
  public readonly lambdaAlarms: readonly Alarm[];
  public readonly lambdaErrorAlarms: readonly Alarm[];
  public readonly dynamoDbAlarms: readonly Alarm[];
  public readonly apiGatewayAlarms: readonly Alarm[];

  constructor(scope: Construct, id: string, props: FreeTierAlarmsProps) {
    super(scope, id);
    const lambdaThreshold =
      props.lambdaDailyInvocationThreshold ?? DEFAULT_LAMBDA_DAILY_INVOCATIONS;
    const lambdaErrorThreshold = props.lambdaDailyErrorsThreshold ?? DEFAULT_LAMBDA_DAILY_ERRORS;
    const ddbThreshold = props.dynamoDbDailyConsumedThreshold ?? DEFAULT_DDB_DAILY_CONSUMED;
    const apiGw5xxThreshold = props.apiGateway5xxDailyThreshold ?? DEFAULT_API_GATEWAY_5XX_DAILY;
    const action = new SnsAction(props.notificationTopic);

    this.lambdaAlarms = props.lambdaFunctionNames.map((fnName, idx) => {
      const alarm = new Alarm(this, `LambdaInvocations${sanitize(fnName)}${idx}`, {
        alarmName: `tenkacloud-freetier-lambda-${fnName}`,
        alarmDescription: `Lambda ${fnName} の日次 invocations が ${lambdaThreshold} を超過 (= Free Tier 80% 相当)`,
        metric: new Metric({
          namespace: "AWS/Lambda",
          metricName: "Invocations",
          dimensionsMap: { FunctionName: fnName },
          statistic: "Sum",
          period: Duration.days(1),
          unit: Unit.COUNT,
        }),
        threshold: lambdaThreshold,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(action);
      return alarm;
    });

    // #1080: Lambda errors を日次で監視 (= バグ / 設定ミス / 外部依存障害の早期検知)。
    // Invocations と別 alarm にしているのは、 invocations は cost 観点 / errors は health 観点で
    // 役割が違うため (= operator が同じ通知でも文脈で切り分けられる)。
    this.lambdaErrorAlarms = props.lambdaFunctionNames.map((fnName, idx) => {
      const alarm = new Alarm(this, `LambdaErrors${sanitize(fnName)}${idx}`, {
        alarmName: `tenkacloud-health-lambda-errors-${fnName}`,
        alarmDescription: `Lambda ${fnName} の日次 Errors が ${lambdaErrorThreshold} 件を超過 (= バグ / 設定ミス疑い)`,
        metric: new Metric({
          namespace: "AWS/Lambda",
          metricName: "Errors",
          dimensionsMap: { FunctionName: fnName },
          statistic: "Sum",
          period: Duration.days(1),
          unit: Unit.COUNT,
        }),
        threshold: lambdaErrorThreshold,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(action);
      return alarm;
    });

    // #1080: API Gateway 5XX rate alarm。 HTTP / REST で metric name が異なるので分岐。
    this.apiGatewayAlarms = (props.apiGateways ?? []).map((api, idx) => {
      const metricName = api.kind === "http" ? "5xx" : "5XXError";
      const dimensions =
        api.kind === "http"
          ? { ApiId: api.apiId, ...(api.stage ? { Stage: api.stage } : {}) }
          : { ApiName: api.apiName, ...(api.stage ? { Stage: api.stage } : {}) };
      const alarm = new Alarm(this, `ApiGateway5xx${sanitize(api.label)}${idx}`, {
        alarmName: `tenkacloud-health-apigw-5xx-${api.label}`,
        alarmDescription: `ApiGateway ${api.label} の日次 5XX が ${apiGw5xxThreshold} 件を超過 (= backend 障害疑い)`,
        metric: new Metric({
          namespace: "AWS/ApiGateway",
          metricName,
          dimensionsMap: dimensions,
          statistic: "Sum",
          period: Duration.days(1),
          unit: Unit.COUNT,
        }),
        threshold: apiGw5xxThreshold,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(action);
      return alarm;
    });

    this.dynamoDbAlarms = props.dynamoDbTableNames.flatMap((tableName, idx) => {
      const readAlarm = new Alarm(this, `DdbReadCapacity${sanitize(tableName)}${idx}`, {
        alarmName: `tenkacloud-freetier-ddb-read-${tableName}`,
        alarmDescription: `DDB ${tableName} の日次 ConsumedReadCapacityUnits が ${ddbThreshold} を超過`,
        metric: new Metric({
          namespace: "AWS/DynamoDB",
          metricName: "ConsumedReadCapacityUnits",
          dimensionsMap: { TableName: tableName },
          statistic: "Sum",
          period: Duration.days(1),
          unit: Unit.COUNT,
        }),
        threshold: ddbThreshold,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      readAlarm.addAlarmAction(action);
      const writeAlarm = new Alarm(this, `DdbWriteCapacity${sanitize(tableName)}${idx}`, {
        alarmName: `tenkacloud-freetier-ddb-write-${tableName}`,
        alarmDescription: `DDB ${tableName} の日次 ConsumedWriteCapacityUnits が ${ddbThreshold} を超過`,
        metric: new Metric({
          namespace: "AWS/DynamoDB",
          metricName: "ConsumedWriteCapacityUnits",
          dimensionsMap: { TableName: tableName },
          statistic: "Sum",
          period: Duration.days(1),
          unit: Unit.COUNT,
        }),
        threshold: ddbThreshold,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      writeAlarm.addAlarmAction(action);
      return [readAlarm, writeAlarm];
    });
  }
}

/** Alarm logical ID に英数字以外を入れられないので safe ID に変換する。 */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "");
}
