import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";
import { auditLogEnabledEnv } from "./audit-log-env.js";
import { controlDataBackendEnv } from "./control-data-backend-env.js";
import { buildAzureCredentialParameterArnPattern } from "./handlers/shared/azure-credential-store.js";
import { buildGcpCredentialParameterArnPattern } from "./handlers/shared/gcp-credential-store.js";
import { buildSakuraCredentialParameterArnPattern } from "./handlers/shared/sakura-credential-store.js";

export interface EventApiLambdaProps {
  /**
   * [Issue #2440 / ADR-049 §5.1 Phase A5] `controlDataBackend` が純 SQL (`turso`) のとき、
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env
   * `EVENTS_TABLE_NAME` は注入せず、grant も付与しない — Events CRUD は repository seam
   * (`resolveEventRepositories`) が SQL executor 直結で処理する。`dynamodb` では
   * 従来どおり必ず渡される。
   */
  readonly eventsTable?: Table;
  /** {@link eventsTable} と同じ条件 (純 SQL 選択時は `undefined`)。 */
  readonly teamsTable?: Table;
  /**
   * Phase 2a (Bulk Deploy / Bulk Teardown) で deployment 行を作成 / 状態更新するため
   * 既存 Deployments table への RW 権限が必要。
   *
   * [Issue #2441 / Phase B PR-6] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env も
   * grant も付与しない — Deployments read/write は repository seam
   * (`resolveDeploymentsRepository`) が SQL executor 直結で処理する。
   */
  readonly deploymentsTable?: Table;
  /**
   * Phase 2.2 (Issue #459): Bulk Deploy が deploy 前に verified=true 行のみ許可する
   * gate のため、CompetitorAccounts table を Read する。
   *
   * [Issue #2442 / Phase C2] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env
   * `COMPETITOR_ACCOUNTS_TABLE_NAME` は注入せず、grant も付与しない — verified-gate lookup /
   * CRUD は repository seam (`resolveCompetitorAccountsRepository`) が本 Lambda に既に配線
   * 済みの Turso executor (`tursoDatabaseUrl` / SSM grant、下記) 経由で処理する
   * ({@link eventsTable} と同じ条件)。
   */
  readonly competitorAccountsTable?: Table;
  /**
   * Phase 2a で `DeployCreateRequested` / `DeployDeleteRequested` を fan-out publish
   * するため、ControlPlane の共通 EventBus への PutEvents 権限を grant する。
   */
  readonly eventBus: IEventBus;
  /**
   * Bulk deploy 時に problemId → problemDir を解決するための hard-coded カタログ。
   * Phase 2 (ADR-003) で DDB catalog に置換される予定。
   */
  readonly problemsCatalog: Readonly<Record<string, string>>;
  /** Issue #2604: normalized, spoiler-safe education graph input baked into the bundle. */
  readonly problemsEducationGraph?: Readonly<Record<string, unknown>>;
  /**
   * Issue #888: Red Team Disruption Injection の audit + idempotency 用 DDB table。
   *
   * [Issue #2442 / Phase C3] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env
   * `DISRUPTIONS_TABLE_NAME` は注入せず、grant も付与しない — disruption fire / audit /
   * catalog は repository seam (`resolveDisruptionsRepository`) が本 Lambda に既に配線済みの
   * Turso executor 経由で処理する ({@link eventsTable} と同じ条件)。
   */
  readonly disruptionsTable?: Table;
  /**
   * Issue #2410 Slice 2: キャパ監視 (`GET /admin/capacity`) が DescribeTable する
   * event-hot テーブルの 1 つ。他 4 テーブル (Events / Teams / Deployments / Disruptions)
   * は既存 props を流用し、本 prop で 5 テーブルが揃う。
   *
   * [Issue #2442 / Phase C1] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env
   * `PROBLEM_ENDPOINTS_TABLE_NAME` は注入せず、DescribeTable IAM の対象からも外す — override
   * registry の読み書きは repository seam (`resolveProblemEndpointsRepository`) が SQL executor
   * 直結で処理する。`dynamodb` では従来どおり必ず渡される。
   */
  readonly problemEndpointsTable?: Table;
  /**
   * Issue #2410 Slice 1 の SSM Automation document 名。`GET /admin/capacity` response に
   * echo され、event 管理画面がそのまま実行コマンド例を表示する。純 SQL backend では
   * event-hot DynamoDB table も runbook も無いため未指定。
   */
  readonly capacityRunbookDocumentName?: string;
  /**
   * Issue #2680: Slice 1 runbook の automation role ARN。`POST /admin/capacity` が document
   * default の `AutomationAssumeRole` を渡すのに必要な `iam:PassRole` の対象。
   * {@link capacityRunbookDocumentName} と両方揃ったときだけ StartAutomationExecution /
   * PassRole の IAM を付与する。純 SQL backend では runbook 自体が無いため未指定。
   */
  readonly capacityRunbookAutomationRoleArn?: string;
  /**
   * Issue #888: problem metadata.json の `disruptions[]` 宣言。 Lambda runtime で
   * `(problemId, disruptionId)` lookup に使う。
   */
  readonly problemsDisruptions: Readonly<Record<string, readonly unknown[]>>;
  /**
   * Issue #2464: problemId → pack provenance map for pack-sourced catalog entries only.
   * Burned into the handler with esbuild define; core-only path is `{}`.
   */
  readonly problemsProvenance?: Readonly<Record<string, unknown>>;
  /**
   * tenantId として handler に渡す `DEFAULT_TENANT_ID` env (DeployApi と同じ fallback)。
   * Cognito JWT 結線後は JWT claim から取る。
   */
  readonly defaultTenantId?: string;
  /**
   * SSM SecureString path 構築用の env 名 (Phase 2.2)。Bulk Deploy が DeployCreate-
   * Requested detail に詰める `externalIdParameterName` のために必要 (= CompetitorAccountsApi
   * Lambda と同じ env 名)。
   */
  readonly environmentName: string;
  /**
   * Issue #910 (#895 Phase 2.C): bulk batch payload を保存する S3 bucket。 未配線
   * (= 旧 fan-out のみ) なら undefined。 wire 時に bulk-deploy.ts が PutObject で
   * deployment 配列を書き、 1 BulkDeployCreateRequested event を publish する。
   */
  readonly bulkDeployPayloadBucket?: IBucket;
  /**
   * Issue #910: Distributed Map 経路への切替 flag。 "true" で bulk-deploy.ts が S3 PutObject
   * + 1 event publish に切替。 未設定 / "false" は旧 fan-out 維持 (= rollback safety)。
   */
  readonly useBulkDistributedMap?: boolean;
  /**
   * Issue #950 (ADR-020 Phase D): admin 操作 audit log 用 DDB Table。 deploy-api-lambda と同じ。
   */
  readonly adminAuditLogTable?: Table;
  /**
   * Issue #2311: 監査ログ feature flag。false で `AUDIT_LOG_ENABLED="false"` を注入し no-op 化。
   */
  readonly auditLogEnabled?: boolean;
  /**
   * Issue #2290 (ADR-049 §5.1): control-plane data backend (dynamodb|turso)。event-handler の
   * `getEventDetail` が Events / Teams repository を組み立てる seam を切替える。default (未指定 /
   * `dynamodb`) は env を足さず byte 互換、`turso` で `CONTROL_DATA_BACKEND` を注入する。
   */
  readonly controlDataBackend?: string;
  /** Public remote libSQL URL. Never contains authentication material. */
  readonly tursoDatabaseUrl?: string;
  /** SSM SecureString parameter name containing the libSQL auth token. */
  readonly tursoAuthTokenParameterName?: string;
  /**
   * [ADR-023 / #2054 / Issue #2571] 非 aws/cloudformation の runtime を宣言した問題のみ
   * (= `{problemId: {provider,engine,entry}}`)。`discoverProblemsRuntime` の戻り値、
   * DeployApiLambda の同名 prop と同一 source。Bulk Deploy (event-handler の
   * `buildEventSharedResources`) が `makeProblemRuntimeDescriptorResolver` 経由でここから
   * 注入される `BATTLE_PROBLEMS_RUNTIMES` を読み、非 AWS single-provider 問題を adapter
   * dispatch する (#2561 の single-deploy 経路と揃える)。未配線 (`undefined`) は空 map に
   * 正規化 (= 全 AWS 扱いの v1 refusal のまま、silent skip にはならない)。
   */
  readonly problemRuntimes?: Readonly<Record<string, unknown>>;
}

/**
 * [Issue #2410 Slice 2 / #2440 / #2442] Grants the DynamoDB and CloudWatch capacity-read actions
 * only when event-hot tables actually exist. Extracted out of the constructor to keep its complexity
 * budget: under a pure SQL backend the array can be fully empty (Events/Teams/Deployments/
 * ProblemEndpoints/Disruptions all synth-skipped), and a `PolicyStatement` with zero
 * `resources` fails CFn's "at least one resource" validation — so the statement itself is
 * conditional, not just its input tables.
 */
function grantEventHotCapacityRead(
  fn: NodejsFunction,
  tables: readonly (Table | undefined)[],
): void {
  const eventHotTables = tables.filter((t): t is Table => t !== undefined);
  if (eventHotTables.length === 0) return;
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ["dynamodb:DescribeTable"],
      resources: eventHotTables.map((t) => t.tableArn),
    }),
  );
  // justify: cloudwatch:GetMetricData has no resource-level permission support (AWS API
  // constraint). Keep the broad resource only on stacks that actually expose event-hot
  // DynamoDB tables.
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ["cloudwatch:GetMetricData"],
      resources: ["*"],
    }),
  );
}

function capacityRunbookEnv(documentName: string | undefined): Record<string, string> {
  return documentName ? { CAPACITY_RUNBOOK_DOCUMENT_NAME: documentName } : {};
}

/**
 * [Issue #2680] `POST /admin/capacity` が Slice 1 runbook を起動するための最小 IAM。
 * document + automation role が両方配線された stack (= dynamodb backend) だけに付与する。
 * 純 SQL backend では runbook 自体が synth されないため、この statement も一切残らない。
 *
 *  - ssm:StartAutomationExecution — 対象はこの stack の runbook document (全 version) のみ。
 *    実行対象 ARN は `automation-definition/<name>` 形式 (document ARN とは別 namespace)。
 *  - iam:PassRole — document default の `AutomationAssumeRole` (least-privilege role) のみ。
 */
function grantCapacityRunbookExecute(
  fn: NodejsFunction,
  stack: Stack,
  documentName: string | undefined,
  automationRoleArn: string | undefined,
): void {
  if (!documentName || !automationRoleArn) return;
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ["ssm:StartAutomationExecution"],
      resources: [
        `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:automation-definition/${documentName}:*`,
      ],
    }),
  );
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [automationRoleArn],
    }),
  );
}

export function eventApiBundlingDefine(props: {
  readonly problemsCatalog: Readonly<Record<string, string>>;
  readonly problemsEducationGraph?: Readonly<Record<string, unknown>>;
  readonly problemsDisruptions: Readonly<Record<string, readonly unknown[]>>;
  readonly problemsProvenance?: Readonly<Record<string, unknown>>;
  readonly problemRuntimes?: Readonly<Record<string, unknown>>;
}): Record<string, string> {
  // BATTLE_PROBLEMS_EDUCATION_GRAPH はここに無い。 実測 309 KiB で Linux の argv
  // 1 引数上限 (128 KiB) を超え、 CI の bundling を E2BIG で殺した (#2891)。
  // eventApiBundledData 経由で bundle 同梱ファイルになり、 readCatalogBlob が読む。
  return {
    "process.env.BATTLE_PROBLEMS_CATALOG": JSON.stringify(JSON.stringify(props.problemsCatalog)),
    "process.env.BATTLE_PROBLEMS_DISRUPTIONS": JSON.stringify(
      JSON.stringify(props.problemsDisruptions),
    ),
    "process.env.BATTLE_PROBLEMS_PROVENANCE": JSON.stringify(
      JSON.stringify(props.problemsProvenance ?? {}),
    ),
    // [Issue #2571] Bulk Deploy の adapter dispatch (event-handler の
    // `makeProblemRuntimeDescriptorResolver`) が読む runtime catalog。DeployApiLambda と同じく
    // esbuild define channel に載せる (#1308 の 4KB env 上限回避パターンを踏襲)。
    "process.env.BATTLE_PROBLEMS_RUNTIMES": JSON.stringify(
      JSON.stringify(props.problemRuntimes ?? {}),
    ),
  };
}

/** カタログと共に育つ blob。 argv (define) ではなく bundle 同梱ファイルで運ぶ (#2891)。 */
export function eventApiBundledData(props: {
  readonly problemsEducationGraph?: Readonly<Record<string, unknown>>;
}): Record<string, string> {
  return {
    BATTLE_PROBLEMS_EDUCATION_GRAPH: JSON.stringify(props.problemsEducationGraph ?? {}),
  };
}

/**
 * Event / Team CRUD + Bulk Deploy 用の Lambda (ADR-004 Phase 1+2a)。
 *
 * tenant API (TenantTemplateStack の REST API + Cognito authorizer) から
 * `LambdaIntegration` で invoke される。Phase 2a で `POST /events/{id}/deploy` /
 * `DELETE /events/{id}` が追加され、deployment 行 (Deployments table) の作成 /
 * 状態更新と EventBridge fan-out publish (DeployCreateRequested /
 * DeployDeleteRequested) を担う。実 CFn deploy / delete は既存 DeployCreate /
 * DeployDelete State Machine が個別に拾って実行する。
 */
export class EventApiLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: EventApiLambdaProps) {
    super(scope, id);

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/event-handler/index.ts"),
      // Bulk teardown は teams × problems 全行を Update + chunk publish するので
      // teams=25 × problems=30 = 750 行で 30 秒前後を見込む。Phase 3 で Distributed
      // Map に切り出すまでの暫定。
      timeout: Duration.seconds(60),
      // 512MB では本番実測で 510/512MB まで張り付き、cold start で Runtime.OutOfMemory を
      // 断続的に起こしていた (機能フラグ / イベント一覧の取得失敗)。events + feature-flags +
      // disruptions を 1 handler で捌く重量級なので 1024MB へ引き上げる。
      memorySize: 1024,
      environment: {
        // Issue #2440: 純 SQL backend では table が無いので env も足さない (= CFn byte 互換 /
        // cold start が EVENTS_TABLE_NAME 不在でも通る)。
        ...(props.eventsTable ? { EVENTS_TABLE_NAME: props.eventsTable.tableName } : {}),
        ...(props.teamsTable ? { TEAMS_TABLE_NAME: props.teamsTable.tableName } : {}),
        // Issue #2441: 純 SQL backend では table 自体が無いので env も足さない。
        ...(props.deploymentsTable
          ? { DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName }
          : {}),
        // Phase 2.2 (Issue #459): bulk-deploy が CompetitorAccounts table を引いて verified-only
        // gate を実現するため、table 名と SSM path 構築用 env 名を Lambda 環境に注入する。
        // Issue #2442: 純 SQL backend では table 自体が無いので env も足さない。
        ...(props.competitorAccountsTable
          ? { COMPETITOR_ACCOUNTS_TABLE_NAME: props.competitorAccountsTable.tableName }
          : {}),
        DEPLOY_ENVIRONMENT: props.environmentName,
        DEPLOY_EVENT_BUS_NAME: props.eventBus.eventBusName,
        // #686: legacy "unknown-tenant" fallback は削除 (= JWT claim 欠落時は handler が 401)
        ...(props.defaultTenantId ? { DEFAULT_TENANT_ID: props.defaultTenantId } : {}),
        // Issue #888: disruption fire / catalog / audit Lambda 経路で参照
        // Issue #2442: 純 SQL backend では table 自体が無いので env も足さない。
        ...(props.disruptionsTable
          ? { DISRUPTIONS_TABLE_NAME: props.disruptionsTable.tableName }
          : {}),
        // Issue #2410 Slice 2: キャパ監視の event-hot 5 テーブル目 + runbook document 名。
        // Issue #2442: 純 SQL backend では table 自体が無いので env も足さない。
        ...(props.problemEndpointsTable
          ? { PROBLEM_ENDPOINTS_TABLE_NAME: props.problemEndpointsTable.tableName }
          : {}),
        ...capacityRunbookEnv(props.capacityRunbookDocumentName),
        // Issue #910 (#895 Phase 2.C.2.b): bulk batch payload S3 bucket + feature flag。
        // bucket 未配線時は空文字、 flag は default false (= 旧 fan-out 維持)。
        BULK_DEPLOY_PAYLOAD_BUCKET: props.bulkDeployPayloadBucket?.bucketName ?? "",
        BULK_DEPLOY_VIA_DISTRIBUTED_MAP: props.useBulkDistributedMap ? "true" : "false",
        // Issue #950: audit log table 名 (未配線なら空文字)
        ADMIN_AUDIT_LOG_TABLE_NAME: props.adminAuditLogTable?.tableName ?? "",
        // Issue #2311: 監査ログ feature flag (無効時のみ AUDIT_LOG_ENABLED="false" を注入)。
        ...auditLogEnabledEnv(props.auditLogEnabled),
        // Issue #2290: control-plane data backend (default dynamodb は env を足さず byte 互換)。
        ...controlDataBackendEnv(props.controlDataBackend ?? "dynamodb"),
        ...(props.tursoDatabaseUrl ? { TURSO_DATABASE_URL: props.tursoDatabaseUrl } : {}),
        ...(props.tursoAuthTokenParameterName
          ? { TURSO_AUTH_TOKEN_PARAMETER_NAME: props.tursoAuthTokenParameterName }
          : {}),
        NODE_OPTIONS: "--enable-source-maps",
      },
      // Issue #1308: BATTLE_PROBLEMS_CATALOG + BATTLE_PROBLEMS_DISRUPTIONS は問題が増える
      // たび growing し、 4 KB Lambda env hard limit に張り付いた (= EventApi の deploy が
      // CREATE_FAILED)。 #1158 (GenericScoring / ParticipantPortal) と同じ esbuild define で
      // build 時に literal 置換し env を 0 化する。 handler は process.env を読む既存 code の
      // まま (= build 後に literal JSON 文字列が埋まる)。 tests は process.env 経由で fixture を
      // 注入するので影響なし。
      bundlingDefine: eventApiBundlingDefine(props),
      bundledData: eventApiBundledData(props),
    });

    // Events / Teams への RW (Phase 1 の CRUD)、Deployments への RW (Phase 2a の
    // bulk deploy / teardown で行を Put + Update)、EventBus への PutEvents (fan-out)。
    // Issue #2440: 純 SQL backend では table 自体が無いので grant も付与しない。
    props.eventsTable?.grantReadWriteData(this.fn);
    props.teamsTable?.grantReadWriteData(this.fn);
    props.deploymentsTable?.grantReadWriteData(this.fn);
    // Phase 2.2 (Issue #459): CompetitorAccounts は read-only (verified gate のみ)。
    // verify / Put / Delete は CompetitorAccountsApiLambda 側で行うので、本 Lambda には
    // RW を付与しない (= 最小権限)。Issue #2442: 純 SQL backend では table 自体が無いので
    // grant も付与しない。
    props.competitorAccountsTable?.grantReadData(this.fn);
    props.eventBus.grantPutEventsTo(this.fn);
    // Issue #888: disruption audit + idempotency 用に RW、 EventBus PutEvents は既存付与で十分
    // (= disruption fire でも同 bus に publish するため)。
    // Issue #2442: 純 SQL backend では table 自体が無いので grant も付与しない。
    props.disruptionsTable?.grantReadWriteData(this.fn);
    // Issue #950 (ADR-020 Phase D): admin 操作 audit log は write が中心 (mutate 系 handler の append)。
    // Issue #1313: 追加で Tenant Admin Console 向け read endpoint
    //   GET /admin/audit-log (`registerAuditLogRoutes`) が同 Lambda 内に register 済 (Issue #1292)
    // のため、 read 権限も必須。 旧 `grantWriteData` だけだと AccessDenied で 5xx になり、
    // UI が "Failed to fetch" を表示する (PR review で `[USER-REVIEW]` として残っていた配線完了)。
    props.adminAuditLogTable?.grantReadWriteData(this.fn);
    if (props.tursoAuthTokenParameterName) {
      this.fn.addToRolePolicy(
        new PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:${Stack.of(this).partition}:ssm:${Stack.of(this).region}:${
              Stack.of(this).account
            }:parameter/${props.tursoAuthTokenParameterName.replace(/^\/+/, "")}`,
          ],
        }),
      );
    }
    // Issue #910 (#895 Phase 2.C.2.b): bulk payload bucket への PutObject 権限。 bucket が
    // 渡されたときのみ grant (= 未配線時の余分な IAM を避ける)。 useBulkDistributedMap が
    // false でも grant を入れておくと、 flag を flip するだけで切替できる (= 段階移行)。
    if (props.bulkDeployPayloadBucket) {
      props.bulkDeployPayloadBucket.grantPut(this.fn);
    }
    // Issue #2410 Slice 2: キャパ監視 (`GET /admin/capacity`) は event-hot 5 テーブルの
    // DescribeTable (現行プロビジョン読み取り) + CloudWatch GetMetricData (消費/throttle) のみ。
    // GetMetricData は resource-level permission 非対応のため resources は "*" (AWS 仕様)。
    grantEventHotCapacityRead(this.fn, [
      props.eventsTable,
      props.teamsTable,
      props.deploymentsTable,
      props.problemEndpointsTable,
      props.disruptionsTable,
    ]);
    // Issue #2680: `POST /admin/capacity` が Slice 1 runbook を起動する (document + automation
    // role が両方揃った stack のみ。scope はその 2 ARN に限定 — wildcard 無し)。
    grantCapacityRunbookExecute(
      this.fn,
      Stack.of(this),
      props.capacityRunbookDocumentName,
      props.capacityRunbookAutomationRoleArn,
    );
    // [ADR-037 Slice 2] recurring disruption の早期解除 (operator の一覧→Cancel) は、 executor が作った
    // `tc-recur-*` rate schedule を同一アカウントから消す。 DeleteSchedule を tc-recur-* に scope して付与
    // (= 最小権限。 作成は executor、 削除は本 Lambda)。 EndDate 到達分は aws-scheduler が自動削除する。
    this.fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["scheduler:DeleteSchedule"],
        resources: [
          `arn:aws:scheduler:${Stack.of(this).region}:${Stack.of(this).account}:schedule/default/tc-recur-*`,
        ],
      }),
    );
    // [ADR-026/027/032 / Issue #2571] Bulk Deploy が非 AWS single-provider 問題を adapter 経路で
    // dispatch する際、 team ごとの sakura/azure/gcp credential (SSM SecureString) の登録有無確認 +
    // 取得が必要。 DeployApiLambda / GenericScoringLambda と同じ prefix-scope + AWS managed key 復号で
    // 最小権限を保つ。 ExternalId pattern はここに含めない — bulk 非 AWS dispatch は ExternalId を
    // 読まない (AWS bulk path は parameter 名だけを event detail に詰め、 復号は downstream の
    // DeployApi/Worker Lambda が行う)。
    const stack = Stack.of(this);
    const credentialSsmArns = [
      buildSakuraCredentialParameterArnPattern(stack.region, stack.account, props.environmentName),
      buildAzureCredentialParameterArnPattern(stack.region, stack.account, props.environmentName),
      buildGcpCredentialParameterArnPattern(stack.region, stack.account, props.environmentName),
    ];
    this.fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: credentialSsmArns,
      }),
    );
    // justify: KMS Decrypt は SSM SecureString 復号 (AWS managed key `alias/aws/ssm`) 用で ARN が
    // synth 時に定まらない — `kms:EncryptionContext:PARAMETER_ARN` の StringLike condition で
    // 上記 3 credential パスに実質 scope する (#2571、deploy-api-lambda.ts と同型)。
    this.fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringLike: { "kms:EncryptionContext:PARAMETER_ARN": credentialSsmArns },
        },
      }),
    );
  }
}
