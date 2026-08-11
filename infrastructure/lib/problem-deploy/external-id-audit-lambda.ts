import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";
import { controlDataBackendEnv } from "./control-data-backend-env.js";

export interface ExternalIdAuditLambdaProps {
  /**
   * `CompetitorAccounts` DDB table (rotatedAt / createdAt を読み取る)。
   *
   * [Issue #2442 / Phase C2] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env
   * `COMPETITOR_ACCOUNTS_TABLE_NAME` は注入せず grant も付与しない — 日次 rotation 監査は
   * repository seam (`resolveCompetitorAccountsRepository`) が下記の Turso executor 配線
   * 経由で処理する ({@link CompetitorAccountsApiLambda} と同じ、本 Lambda 自身が
   * 「DB を開く Lambda」)。
   */
  readonly competitorAccountsTable?: ITable;
  /**
   * CloudWatch メトリクスの `Environment` dimension 値。`development` / `staging` /
   * `production` (= `ProblemDeployBackendStack` の `environmentName` と同じ)。
   */
  readonly environmentName: string;
  /**
   * Issue #2290: control-plane data backend (dynamodb|turso)。
   * default (未指定 / `dynamodb`) は env を足さず byte 互換。
   */
  readonly controlDataBackend?: string;
  /** Public remote libSQL URL. Never contains authentication material. */
  readonly tursoDatabaseUrl?: string;
  /** SSM SecureString parameter name containing the libSQL auth token. */
  readonly tursoAuthTokenParameterName?: string;
}

/**
 * Phase 3.2 / Issue #603: ExternalId rotation age 監査 Lambda。
 *
 * 1 日 1 回 EventBridge Scheduler (= `rate(1 day)`) から起動。CompetitorAccounts を全件走査し、
 * 各行の `rotatedAt` (= 未 rotate なら `createdAt`) から経過した日数を CloudWatch メトリクス
 * `TenkaCloud/CompetitorAccounts/RotationAge` に publish する。
 *
 * **明示的な SSM version cleanup Lambda は作らない**:
 *   SSM Parameter Store は最新 100 version を auto-retain し、それ以上は自動 drop する。
 *   TenkaCloud の rotation cadence (= 四半期に 1 回程度) では 100 version cap に到達する
 *   現実が無いため、cleanup を Lambda で書く費用対効果は negative。代わりに「rotation
 *   していない tenant」を operator が CloudWatch Alarm で観察できる本 Lambda を入れる
 *   (Issue #603 の honest scope evaluation)。
 *
 * 必要権限:
 *   - DDB `CompetitorAccounts` 全行 Scan (dynamodb backend のみ、pure SQL では SSM Turso token read に置換)
 *   - CloudWatch `PutMetricData` (namespace を Condition で絞る)
 */
export class ExternalIdAuditLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: ExternalIdAuditLambdaProps) {
    super(scope, id);

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/external-id-audit-handler/index.ts"),
      // DDB Scan + PutMetricData 1 回。MVP 規模で 5s 以内に終わる想定だが余裕で 60s。
      timeout: Duration.seconds(60),
      // Issue #2647: 純 SQL backend では control-data runtime 経由で `@libsql/client/http` を
      // AWS SDK と併せて読む。過去に sibling handler へ混入した CDK runtime dependency は
      // bundle test で再発を防ぐ。live 再測定までは余裕を持たせた 1024MB を維持する。
      memorySize: 1024,
      environment: {
        // Issue #2442: 純 SQL backend では table 自体が無いので env も足さない。
        ...(props.competitorAccountsTable
          ? { COMPETITOR_ACCOUNTS_TABLE_NAME: props.competitorAccountsTable.tableName }
          : {}),
        DEPLOY_ENVIRONMENT: props.environmentName,
        // Issue #2442: control-plane data backend (default dynamodb は env を足さず byte 互換)。
        ...controlDataBackendEnv(props.controlDataBackend ?? "dynamodb"),
        ...(props.tursoDatabaseUrl ? { TURSO_DATABASE_URL: props.tursoDatabaseUrl } : {}),
        ...(props.tursoAuthTokenParameterName
          ? { TURSO_AUTH_TOKEN_PARAMETER_NAME: props.tursoAuthTokenParameterName }
          : {}),
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    // DDB Scan の権限 (CompetitorAccounts のみ)。Read のみ — 監査 lambda は write しない。
    // Issue #2442: 純 SQL backend では table 自体が無いので grant も付与しない。
    props.competitorAccountsTable?.grantReadData(this.fn);

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

    // [Issue #2442]: turso backend が Turso auth token を読むための SSM SecureString
    // read 権限。 未配線 (= dynamodb default) なら付与しない (`EventApiLambda` と同型)。
    if (props.tursoAuthTokenParameterName) {
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:${Stack.of(this).partition}:ssm:${Stack.of(this).region}:${
              Stack.of(this).account
            }:parameter/${props.tursoAuthTokenParameterName.replace(/^\/+/, "")}`,
          ],
        }),
      );
    }

    // 1 日 1 回起動。`Duration.days(1)` は EventBridge では `rate(1 day)` に展開される。
    new Rule(this, "Schedule", {
      schedule: Schedule.rate(Duration.days(1)),
      description:
        "TenkaCloud ExternalId rotation age audit (Phase 3.2 / Issue #603): 1 日 1 回 CompetitorAccounts を走査し RotationAge metric を emit。",
      targets: [new LambdaFunction(this.fn)],
    });
  }
}
