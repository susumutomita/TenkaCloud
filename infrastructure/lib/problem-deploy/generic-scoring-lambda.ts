import * as path from "node:path";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { type IEventBus, Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import {
  LAMBDA_NODEJS_BUNDLING_TARGET,
  LAMBDA_NODEJS_RUNTIME,
  LAMBDA_SOURCE_MAP_ENABLED,
} from "../utils/lambda-runtime.js";
import { buildAzureCredentialParameterArnPattern } from "./handlers/shared/azure-credential-store.js";
import { buildGcpCredentialParameterArnPattern } from "./handlers/shared/gcp-credential-store.js";
import { buildSakuraCredentialParameterArnPattern } from "./handlers/shared/sakura-credential-store.js";

export interface GenericScoringLambdaProps {
  readonly deploymentsTable: ITable;
  /**
   * Events table。Event status の auto-transition (#557 / #539) を 1-min tick で reconcile する。
   * 採点 dispatcher とは独立の責務だが、 cron schedule (= rate(1 minute)) を共有する。
   */
  readonly eventsTable: ITable;
  /**
   * [ADR-047 follow-up] Teams table (read-only)。 scheduled auto-deploy が `bulkDeployEvent` 経由で
   * event の teams を Query して teams × problems の deployment 行を一括生成するため。 これを配線すると
   * `buildScheduledDeployResources()` が有効化され、 reconciler が deployAt 経過の DRAFT event を
   * 自動 deploy する (未配線なら dormant、 teardownAt の鏡像)。
   */
  readonly teamsTable: ITable;
  /**
   * [ADR-047 follow-up] `{ [problemId]: problemDir }` の catalog。 scheduled auto-deploy が
   * problemId → problemDir を解決して DeployCreateRequested を組み立てるため。 EventApiLambda の
   * `BATTLE_PROBLEMS_CATALOG` と同じ source (= props.problemsCatalog)。
   */
  readonly problemsCatalog: Readonly<Record<string, string>>;
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
  /**
   * [#1422 / ADR-013 Phase 2] `{ [problemId]: ProblemDisruptionEntry[] }`。 `triggers[]` を持つ
   * disruption を tick で eval し condition-triggered 発火する。 disruptions[] 無しの問題は不在キー。
   */
  readonly problemsDisruptions: Readonly<Record<string, unknown>>;
  /**
   * [ADR-033 / #1665] disruptions audit table。 operator-fired disruption の active 採点効果を tick で
   * 解決するため read-only で query する (= scoring-side effect)。
   */
  readonly disruptionsTable: ITable;
  /**
   * [ADR-047] scheduled auto-teardown が `bulkTeardownEvent` 経由で cross-account teardown の
   * competitorRoleArn / externalId を解決するための CompetitorAccounts table (read-only)。
   * これを配線すると `buildScheduledTeardownResources()` が有効化され、 reconciler が
   * teardownAt 経過の event を自動撤去する (未配線なら dormant)。
   */
  readonly competitorAccountsTable: ITable;
  /**
   * [#1422] condition-triggered disruption の publish 先 event bus (= 手動 fire と同じ deploy bus)。
   * scoring Lambda に `events:PutEvents` を least-privilege で付与する。
   */
  readonly eventBus: IEventBus;
  /**
   * [ADR-026/027/032 / #1410-1412] SSM SecureString path 構築 + 非 AWS runtime status reconciler の
   * credential 解決用の environment 名 (`/<env>/tenants/.../{sakura-api-key|azure-credential|gcp-credential}`)。
   */
  readonly environmentName: string;
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
      logGroup: new LogGroup(this, "FunctionLogGroup", {
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      runtime: LAMBDA_NODEJS_RUNTIME,
      architecture: Architecture.ARM_64,
      entry: path.resolve(import.meta.dirname, "handlers/generic-scoring-handler/index.ts"),
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
        // #1422: condition-triggered disruption の publish 先 (手動 fire と同じ deploy bus)。
        DEPLOY_EVENT_BUS_NAME: props.eventBus.eventBusName,
        // [ADR-026/027/032 / #1410-1412] 非 AWS runtime status reconciler の credential path 構築用。
        DEPLOY_ENVIRONMENT: props.environmentName,
        // [ADR-033 / #1665] operator-fired disruption の active 採点効果を解決するための audit table。
        DISRUPTIONS_TABLE_NAME: props.disruptionsTable.tableName,
        // [ADR-047] scheduled auto-teardown 用。 buildScheduledTeardownResources がこの env を見て
        // 有効化する (未設定なら scheduled teardown は dormant)。
        COMPETITOR_ACCOUNTS_TABLE_NAME: props.competitorAccountsTable.tableName,
        // [ADR-047 follow-up] scheduled auto-deploy 用。 buildScheduledDeployResources がこの env +
        // BATTLE_PROBLEMS_CATALOG (下の define) を見て有効化する (未設定なら scheduled deploy は dormant)。
        TEAMS_TABLE_NAME: props.teamsTable.tableName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: LAMBDA_NODEJS_BUNDLING_TARGET,
        sourceMap: LAMBDA_SOURCE_MAP_ENABLED,
        externalModules: [],
        // problem catalog (scoring / endpoints / phases) を bundle 時に literal 置換する。
        // 旧 #810 の gzip+base64 env var は問題が増えるたび 4 KB 上限に張り付き、
        // stackstack 追加で deploy 不可になった。 esbuild define で
        // process.env.X を build 時に固定 JSON 文字列にし env を 0 化する。
        // tests は process.env 経由で fixture を注入するので影響なし。
        define: {
          "process.env.BATTLE_PROBLEMS_SCORING": JSON.stringify(
            JSON.stringify(props.problemsScoring),
          ),
          "process.env.PROBLEM_ENDPOINTS": JSON.stringify(JSON.stringify(props.problemsEndpoints)),
          "process.env.BATTLE_PROBLEMS_PHASES": JSON.stringify(
            JSON.stringify(props.problemsPhases),
          ),
          // #1422: condition-triggered disruption catalog を build 時 literal 置換 (env 4KB 回避)。
          "process.env.BATTLE_PROBLEMS_DISRUPTIONS": JSON.stringify(
            JSON.stringify(props.problemsDisruptions),
          ),
          // [ADR-047 follow-up] scheduled auto-deploy が problemId→problemDir を解決するための catalog。
          // EventApiLambda と同じく build 時 literal 置換し env 4KB 上限を回避 (#1308 と同パターン)。
          "process.env.BATTLE_PROBLEMS_CATALOG": JSON.stringify(
            JSON.stringify(props.problemsCatalog),
          ),
        },
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
    // [ADR-033 / #1665] disruptions audit table: operator-fired disruption の active 採点効果を
    // event ごとに Query する (= read-only、 scoring-side effect の解決)。
    props.disruptionsTable.grantReadData(this.fn);
    // [ADR-047] scheduled auto-teardown: bulkTeardownEvent が CompetitorAccounts から cross-account
    // role / externalId を解決する (= read-only)。 これで scheduled teardown が有効化される。
    props.competitorAccountsTable.grantReadData(this.fn);
    // [ADR-047 follow-up] scheduled auto-deploy: bulkDeployEvent が event の teams を Query する
    // (= read-only)。 Deployments への TransactWrite / event bus publish は既存 grant を再利用する
    // (deployments.grantReadWriteData + eventBus.grantPutEventsTo)。 これで scheduled deploy が有効化される。
    props.teamsTable.grantReadData(this.fn);
    // #1422: condition-triggered disruption を event bus に publish する (= events:PutEvents、
    // 当該 bus に scope された least-privilege)。
    props.eventBus.grantPutEventsTo(this.fn);

    // [ADR-026/027/032 / #1410-1412] 非 AWS runtime status reconciler が per-team credential
    // (sakura/azure/gcp SecureString) を decrypt 取得する。 deploy-api-lambda と同じ prefix-scope。
    const stack = Stack.of(this);
    const credentialSsmArns = [
      buildSakuraCredentialParameterArnPattern(stack.region, stack.account, props.environmentName),
      buildAzureCredentialParameterArnPattern(stack.region, stack.account, props.environmentName),
      buildGcpCredentialParameterArnPattern(stack.region, stack.account, props.environmentName),
    ];
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: credentialSsmArns,
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringLike: { "kms:EncryptionContext:PARAMETER_ARN": credentialSsmArns },
        },
      }),
    );

    // EventBridge `rate(1 minute)`. Lambda 自身の invoke 権限は LambdaFunction target が自動付与。
    new Rule(this, "Schedule", {
      schedule: Schedule.rate(Duration.minutes(1)),
      description:
        "TenkaCloud 1-min tick: ADR-012 generic scoring dispatcher + Event status reconcile (#557 #539).",
      targets: [new LambdaFunction(this.fn)],
    });
  }
}
