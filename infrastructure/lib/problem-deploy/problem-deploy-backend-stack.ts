import * as cdk from "aws-cdk-lib";
import { CfnOutput } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { EventBus } from "aws-cdk-lib/aws-events";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";
import type { PackAsset } from "../app-config/types.js";
import { buildApiLambdas } from "./build-api-lambdas.js";
import { buildControlDataTables } from "./build-control-data-tables.js";
import { buildDeployPipeline } from "./build-deploy-pipeline.js";
import { buildParticipantPortalSubsystem } from "./build-participant-portal-subsystem.js";
import { buildScoringSubsystem } from "./build-scoring-subsystem.js";
import { CompetitorBootstrapHosting } from "./competitor-bootstrap-hosting.js";
import type { OpsMonitoringConfig } from "./ops-monitoring.js";
import type { ParticipantPortalRuntimeConfig } from "./participant-portal-hosting.js";

export interface ProblemDeployBackendStackProps extends cdk.StackProps {
  /**
   * SBT ControlPlane の EventBus ARN。Deploy 系イベントを流す。
   *
   * Issue #778: Full mode (ControlPlaneStack 経由) では SBT 同梱の
   * EventBus を共有するため必須。 Lite mode (= TenkaCloudLiteStack、 Phase 3) では
   * ControlPlane が存在しないので undefined を渡し、 本 stack 内で local EventBus を作って
   * fallback する。 cross-stack event 受信は Full mode の ServerlessSaaSPipeline 側だけが
   * 行うため、 Lite では local bus で自己完結する。
   */
  readonly eventBusArn?: string;
  /**
   * tenant API から deploy Lambda を invoke する経路で、JWT が解決できなかった場合の
   * `DEFAULT_TENANT_ID` env フォールバック値。
   */
  readonly defaultTenantId?: string;
  /**
   * `install.sh` が repo を zip して upload する S3 bucket 名 (`serverless-saas-{account}-{region}`)。
   * CodeBuild が source として読み出す。
   */
  readonly sourceBucketName: string;
  /** 同 zip の object key (default: `source.zip`)。 */
  readonly sourceObjectKey: string;
  /**
   * `problemId → problemDir` の hard-coded 問題カタログ (MVP-1)。`problems/challenges/hello-world` 等。
   * tenant API Lambda の env に injected され、deploy 起動時に State Machine 入力の
   * `problemDir` を解決する。
   */
  readonly problemsCatalog: Readonly<Record<string, string>>;
  /**
   * `problemId → scoring` の map (`{ kind: "flag", flagOutputKey, points, ... }`)。
   * Participant Portal Lambda が submit-flag 採点に使う。`scoring` を持たない問題は
   * このキーが無い (= 採点無効)。
   */
  readonly problemsScoring: Readonly<Record<string, unknown>>;
  /** Issue #2191: backend-only JA/EN explanations released after event end to solved teams. */
  readonly problemsWriteups?: Readonly<Record<string, unknown>>;
  /**
   * `problemId → endpoints` の map。`discoverProblemsEndpoints`
   * で metadata.json から自動収集して synth 時に注入する。Participant Portal の
   * `/portal/me/problems/:problemId/endpoints` route が default URL を CFn output から
   * 算出するために参照する。`endpoints[]` を持たない問題はこのキーが無い。
   */
  readonly problemsEndpoints: Readonly<Record<string, unknown>>;
  /**
   * `problemId → phases` の map。`discoverProblemsPhases` で
   * metadata.json から自動収集して synth 時に注入する。Generic scoring Lambda の
   * `phased-polling` kind dispatcher が time-based rule 切替に参照する。`phases[]` を
   * 持たない問題はこのキーが無い。 default 空 map (= 既存 hello-world / hello-world-battle
   * 等が `phases` を持たないので) で受ける。
   */
  readonly problemsPhases?: Readonly<Record<string, unknown>>;
  /**
   * Issue #888: `problemId → disruptions[]` の map。 `discoverProblemsDisruptions` で
   * metadata.json から自動収集。 Red Team Disruption Injection の fire API が
   * `(problemId, disruptionId)` の declaration lookup に参照する。 未宣言の問題はキーが無い。
   */
  readonly problemsDisruptions?: Readonly<Record<string, unknown>>;
  /**
   * Issue #2464: pack-sourced `problemId → provenance` map. EventApiLambda uses it at event
   * creation time to pin the active catalog snapshot onto the event record.
   */
  readonly problemsProvenance?: Readonly<Record<string, unknown>>;
  /**
   * Issue #1420: `problemId → { plugin }` の map。 `discoverProblemsCoordination` で
   * metadata.json の `interTeamCoordination.plugin` から自動収集。 CoordinationDispatcher Lambda の
   * scope resolver が team→moduleRef を解決するのに使う。 未宣言の問題はキーが無い。
   */
  readonly problemsCoordination?: Readonly<Record<string, unknown>>;
  /**
   * Issue #1420: `problemId → bundledMjs`。 `bundleCoordinationPlugins` が synth 時に
   * 各 coordination plugin を SDK inline 済み self-contained ESM に bundle したもの。 宣言問題がある時
   * のみ専用 S3 bucket に配置し、 dispatcher が runtime に import() する。 未宣言なら空。
   */
  readonly problemsCoordinationBundles?: Readonly<Record<string, string>>;
  /**
   * Issue #910 (#895 Phase 2.C.2.b): bulk batch deploy を Distributed Map 経路で実行するか
   * (= EventApiLambda の \`BULK_DEPLOY_VIA_DISTRIBUTED_MAP\` env で切替)。 default=false で
   * 旧 fan-out 経路を維持し、 deploy 後に true に切替えて Distributed Map に移行する。
   * rollback も flag を false に戻すだけ。
   */
  readonly useBulkDistributedMap?: boolean;
  /**
   * Issue #2291: DeployCreate を CodeBuild ではなく Lambda CreateStack +
   * DescribeStacks poll 経路にするか (`CDK_PARAM_DEPLOY_VIA_LAMBDA`)。default (未指定 / false) は
   * 在来の CodeBuild 経路で、追加リソースなし = CFn テンプレ byte 互換。true で {@link CfnDeployLambda}
   * を生成し、`DeployCreate` state machine が Lambda + poll 定義に切り替わる。
   */
  readonly deployViaLambda?: boolean;
  /**
   * [Problem Packs / Issue #2462] Installed + active pack revisions to materialize into the source
   * bucket alongside the core `problems/` tree (Lite only; resolved from `.tenkacloud/pack-store` in
   * `bin/tenkacloud-lite.ts`). Only consumed on the Lambda deploy path (`deployViaLambda`).
   * undefined / empty (the default core-only path, and SaaS — pooled activation wiring is #2459) adds
   * no `BucketDeployment` = CFn テンプレ byte 互換。
   */
  readonly packAssets?: readonly PackAsset[];
  /**
   * Issue #2311: 監査ログ出力を on/off する。default (未指定 / true) は
   * 従来どおり監査 Lambda 群 (deploy-api / event-api / competitor-accounts-api /
   * system-audit-writer) が `writeAuditEvent` する。false のとき各 Lambda env に
   * `AUDIT_LOG_ENABLED="false"` を注入し no-op 化する (= 書き込みコスト節約)。
   */
  readonly auditLogEnabled?: boolean;
  /**
   * Issue #2290: control-plane data backend の選択 (`dynamodb` | `turso` | `sql`)。
   * event-handler の `getEventDetail` が Events / Teams repository を組み立てる cold-start factory
   * (`createEventsRepository` / `createTeamsRepository`) の seam を切替える。default (未指定 /
   * `dynamodb`) は監査 Lambda 群 (deploy-api / event-api / competitor-accounts-api /
   * system-audit-writer) の env を足さず在来 DDB 経路 (= CFn テンプレ byte 互換)。`turso` の
   * ときだけ各 Lambda env に `CONTROL_DATA_BACKEND` を注入する。
   */
  readonly controlDataBackend?: string;

  /**
   * [Issue #2959] control-data DDB table を stack 削除後も残すか。未指定 / false は
   * DESTROY (= 既定)。`AppConfig.retainDataTables` をそのまま渡す。
   */
  readonly retainDataTables?: boolean;
  /** Public remote libSQL URL. Required when controlDataBackend is turso. */
  readonly tursoDatabaseUrl?: string;
  /** SSM SecureString parameter name containing the remote libSQL auth token. */
  readonly tursoAuthTokenParameterName?: string;
  /**
   * Issue #642: `problemId → "private"` の map。
   * `discoverProblemsVisibility` で metadata.json から自動収集。 空 map なら全 public 扱い (dormant)。
   */
  readonly problemsVisibility?: Readonly<Record<string, "private">>;
  /**
   * [#2054] `problemId → {provider,engine,entry}` (非 aws のみ)。
   * `discoverProblemsRuntime` の戻り値。deploy-handler が非 AWS 問題を cloud mutation
   * 前に拒否するための runtime catalog。 空 map なら全 AWS 扱い。
   */
  readonly problemRuntimes?: Readonly<Record<string, unknown>>;
  /**
   * Issue #642: private 問題 payload の bucket 名 (`tc-challenges-${env}`)。
   * 未指定なら deploy-handler / event-api Lambda は CHALLENGE_PAYLOAD_BUCKET 空で起動し、
   * presigned URL を発行しない (= dormant)。 ChallengePayloadStack 配備後にここを bind する。
   */
  readonly challengePayloadBucketName?: string;
  /**
   * 競技者向け Participant Portal を S3 + CloudFront で配信する。指定された
   * `runtimeConfig` が runtime-config.json として配置される。Portal backend が
   * 無い段階では `runtimeConfig: "default-dev-mock"` を渡せば mode="dev-mock"
   * のサンプル値で起動する (frontend 単体動作)。未指定なら Portal Hosting を作らない。
   */
  readonly participantPortal?: {
    readonly runtimeConfig: ParticipantPortalRuntimeConfig | "default-dev-mock";
  };
  /**
   * Deploy CodeBuild Project の concurrent build 上限 (#538: Bulk Deploy 並列度)。
   *
   * 未指定 (= default) なら CFn property を出力せず、AWS account 全体の concurrent build
   * quota (region default 60) をフル活用する。Bulk Deploy で 750 stacks 投入時の hard
   * cap は account quota であり、本プロパティで明示的に下げない限り変わらない。
   *
   * 詳細は `DeployCodeBuildProjectProps.concurrentBuildLimit` の docs を参照。
   */
  readonly deployConcurrentBuildLimit?: number;

  /**
   * Issue #2423: score-engine / operator-attacker egress CIDRs. When set, the Lambda deploy
   * path injects this into problem templates that declare `AllowedCidr` so battle app ingress is
   * not left at a catalog default such as 0.0.0.0/0.
   */
  readonly deployAllowedCidrs?: readonly string[];

  /**
   * #1766: tier 別の同時デプロイ上限。DeployApi Lambda の `DEPLOY_QUOTA_BY_TIER` env (JSON)
   * に渡す。未設定ならクォータ無効 (= 在来挙動 / Lite mode)。
   */
  readonly deployQuotaByTier?: {
    readonly basic: number;
    readonly advanced: number;
    readonly platinum: number;
  };
  /**
   * Issue #2406: ops alerting for GenericScoring liveness/errors and monthly cost drift.
   * Undefined means fully dormant: no SNS topic, CloudWatch alarms, or Budget resources.
   */
  readonly opsMonitoring?: OpsMonitoringConfig;
  /**
   * Issue #2019: TrustBridge high-risk enforcement mode for the deploy
   * Lambda (`CLOUD_ACTION_ENFORCEMENT_MODE` env)。 default `"shadow"` (= 既存挙動、
   * 全 deploy が従来経路で CFn diff も無し)。 `"enforce"` で opt-in: 高リスク deploy
   * (= 既存ライブスタックを置換する deploy) を `APPROVAL_PENDING` で保留し、 AssumeRole /
   * CloudFormation を走らせない。
   */
  readonly cloudActionEnforcementMode?: "shadow" | "enforce";
  /**
   * SSM SecureString path 構築用の environment 名 (Issue #459)。
   * `/{environmentName}/tenants/{tenantId}/external-id` の prefix として使う。
   * 例: `development` / `staging` / `production`。
   */
  readonly environmentName: string;
}

/**
 * 問題 deploy backend のスタック (MVP-1)。
 *
 * - `Deployments` テーブル (DDB): jobId / teamLoginKey / displayTeamName 等の participant 体験用 state
 * - `DeployApi` (Lambda): tenant API から invoke される。validation + DDB Put + EventBridge PutEvents
 * - `DeployCodeBuild` (CodeBuild Project): `scripts/deploy-battles.sh` を実行する SBT ScriptJob 同型
 * - `DeployCreate` (Step Functions State Machine): CodeBuildStartBuild `.sync` で deploy 完了を待つ
 * - `DeployEventRule` (EventBridge Rule): `DeployCreateRequested` event を State Machine に流す
 *
 * tenant API の Cognito authorizer + REST route は `TenantTemplateStack` 側で本 stack の
 * `deployApiLambda` を `LambdaIntegration` で invoke する形に組む。
 */
export class ProblemDeployBackendStack extends cdk.Stack {
  /** tenant API から `LambdaIntegration` で invoke される Lambda。 */
  public readonly deployApiLambda: IFunction;
  /**
   * Event / Team CRUD 用の Lambda。tenant API から invoke される。
   */
  public readonly eventApiLambda: IFunction;
  /**
   * Competitor Accounts CRUD + verify 用 Lambda (Issue #459)。
   * tenant API の `/admin/competitor-accounts*` route から invoke される。
   */
  public readonly competitorAccountsApiLambda: IFunction;
  /** Optional Participant Portal backend Lambda. Undefined when portal hosting is disabled. */
  public readonly participantPortalLambda?: IFunction;
  /** Generic scoring dispatcher Lambda. */
  public readonly genericScoringLambda: IFunction;
  /** ExternalId rotation age audit Lambda. */
  public readonly externalIdAuditLambda: IFunction;
  /**
   * Participant Portal の CloudFront URL。Participant Portal が無効化された tenant
   * では undefined。`TenantTemplateStack` が application-admin-console の runtime-config に
   * 注入するため publicly export する (兄弟 deployApiLambda / eventApiLambda と同 pattern)。
   */
  public readonly participantPortalUrl?: string;
  /**
   * Deployments table (#590 で AdminConsoleInsightStack が read-only に
   * 跨ぐため公開)。grantReadData は呼び出し側で行う。
   *
   * [Issue #2441] `controlDataBackend` が純 SQL
   * (`turso`) のときは本 table を **synth しない** (= `undefined`) — DynamoDB
   * standing cost (テーブル+GSI3本=4ユニット常時) をゼロにする。
   * `dynamodb` では従来どおり必ず存在する ({@link eventsTable} と同じ条件)。
   */
  public readonly deploymentsTable?: Table;
  /**
   * Events table (#590 で AdminConsoleInsightStack が cross-stack read する)。
   *
   * [Issue #2440] `controlDataBackend` が純 SQL (`turso`) の
   * ときは本 table を **synth しない** (= `undefined`) — DynamoDB standing cost をゼロにする。
   * `dynamodb` では従来どおり必ず存在する。
   */
  public readonly eventsTable?: Table;
  /**
   * Teams table。Admin Insight の drill-down に read-only 権限を付与する。
   * {@link eventsTable} と同じ条件で純 SQL backend 選択時は `undefined`。
   */
  public readonly teamsTable?: Table;
  /**
   * CompetitorAccounts table name is surfaced to ObservabilityStack metrics.
   *
   * [Issue #2442 / Phase C2] `controlDataBackend` が純 SQL (`turso`) のときは本 table を
   * **synth しない** (= `undefined`) — DynamoDB standing cost をゼロにする A5/B6/C1 と同じ条件。
   * `dynamodb` では従来どおり必ず存在する ({@link problemEndpointsTable} と同じ条件)。
   */
  public readonly competitorAccountsTable?: Table;
  /**
   * ProblemEndpoints table name is surfaced to ObservabilityStack metrics.
   *
   * [Issue #2442 / Phase C1] `controlDataBackend` が純 SQL (`turso`) のときは本 table を
   * **synth しない** (= `undefined`) — DynamoDB standing cost をゼロにする A5/B6 と同じ条件。
   * `dynamodb` では従来どおり必ず存在する ({@link eventsTable} と同じ条件)。
   */
  public readonly problemEndpointsTable?: Table;
  /**
   * Issue #950: admin audit log table。 AdminConsoleInsightStack が
   * cross-stack read で audit UI に出すため公開する (= read-only)。
   *
   * [Issue #2442 / Phase C4] `controlDataBackend` が純 SQL (`turso`) のときは本 table を
   * **synth しない** (= `undefined`) — DynamoDB standing cost をゼロにする A5/B6/C1-C3 と同じ
   * 条件。 `dynamodb` では従来どおり必ず存在する ({@link problemEndpointsTable} と
   * 同じ条件)。 write 元 6 Lambda + admin-insight の read は repository seam
   * (`resolveAdminAuditLogRepository`) 経由で SQL executor 直結するため、pure SQL では本 table
   * への参照が残らない (壊れる参照は下記で個別に条件化)。
   */
  public readonly adminAuditLogTable?: Table;
  /**
   * Issue #1053: 競技者向け CFn bootstrap template (`competitor-bootstrap.yaml`) の S3 public
   * URL。 旧実装は `AdminConsoleHostingStack` に同居していたが、 Lite mode で deploy されない
   * 構造的問題があったため、 両モードが無条件で deploy する本 stack へ移管した。 consumer は
   * `AdminConsoleHostingStack` (SaaS) と `TenantTemplateStack` / `TenkaCloudLiteStack` 経由の
   * `ApplicationAdminConsoleHosting` で、 cross-stack ref で受け取る。
   */
  public readonly competitorBootstrapTemplateUrl: string;
  /** DeployCreate Step Functions State Machine ARN for CloudWatch metrics. */
  public readonly deployCreateStateMachineArn: string;
  /** DeployDelete Step Functions State Machine ARN for CloudWatch metrics. */
  public readonly deployDeleteStateMachineArn: string;
  /** Problem deploy CodeBuild project name for CloudWatch metrics. */
  public readonly deployCodeBuildProjectName?: string;
  /**
   * Issue #2291: Lambda deploy path (`CfnDeployLambda`) function name for the
   * ObservabilityStack dashboard. Present only when `deployViaLambda` is ON (the Lambda is created
   * only then). `undefined` on the default CodeBuild path (flag OFF) → the dashboard adds no
   * CfnDeploy widget (default-safe / byte-identical).
   */
  public readonly cfnDeployLambdaName?: string;
  /**
   * Issue #910 (#895 Phase 2.C): bulk batch deploy 用 Distributed Map State Machine ARN。
   * 後続 PR (= 2.C.2.b) で API Lambda が `StartExecution` で起動する。
   */
  public readonly bulkDeployCreateStateMachineArn: string;
  /**
   * Issue #910: bulk batch payload S3 bucket。 後続 PR で API Lambda が deployment 配列を
   * PutObject する。
   */
  public readonly bulkDeployPayloadBucketName: string;

  constructor(scope: Construct, id: string, props: ProblemDeployBackendStackProps) {
    super(scope, id, props);

    // [Issue #2440 #2441 / #2442] 純 SQL backend (`turso`) は control-data
    // DDB table 群を synth しない。詳細は build-control-data-tables.ts。
    const pureSql = props.controlDataBackend === "turso";
    // control-plane data backend selector + Turso executor wiring, spread into every Lambda
    // construct that "opens the DB" (= resolves a repository seam to a SQL executor)。
    // shape の詳細は build-api-lambdas.ts の ControlDataBackendProps を参照。
    const controlDataBackendProps = {
      controlDataBackend: props.controlDataBackend,
      tursoDatabaseUrl: props.tursoDatabaseUrl,
      tursoAuthTokenParameterName: props.tursoAuthTokenParameterName,
    };

    // [#2527 Slice 5] Subsystem: control-data tables + capacity runbook + table-name outputs。
    const tables = buildControlDataTables(this, {
      pureSql,
      retainDataTables: props.retainDataTables,
    });
    // #590: AdminConsoleInsightStack に cross-stack で渡すため expose する。
    this.deploymentsTable = tables.deployments?.table;
    this.eventsTable = tables.events?.table;
    this.teamsTable = tables.teams?.table;
    this.competitorAccountsTable = tables.competitorAccounts?.table;
    this.problemEndpointsTable = tables.endpoints?.table;
    this.adminAuditLogTable = tables.adminAuditLog?.table;

    // Issue #1053: 競技者向け CFn bootstrap template の S3 hosting を本 stack に持つ。
    // 旧 AdminConsoleHostingStack から移管 (= Lite / SaaS 両モード対応 + 3-phase env-var dance 解消)。
    const competitorBootstrapHosting = new CompetitorBootstrapHosting(
      this,
      "CompetitorBootstrapHosting",
    );
    this.competitorBootstrapTemplateUrl = competitorBootstrapHosting.templateUrl;
    new CfnOutput(this, "CompetitorBootstrapTemplateUrl", {
      value: this.competitorBootstrapTemplateUrl,
      description:
        "Competitor 用 bootstrap CFn テンプレート (= competitor-bootstrap.yaml) の S3 public URL。Quick-create / Update Stack deeplink の TemplateURL に渡す。",
    });
    // Issue #778: eventBusArn が渡されていれば既存の SBT bus を import、
    // 渡されていなければ Lite mode と判定して local EventBus を新規に作る。 後者では Step
    // Functions Rule も local bus にぶら下がるため、 cross-stack 依存が増えない。
    const eventBus = props.eventBusArn
      ? EventBus.fromEventBusArn(this, "ImportedEventBus", props.eventBusArn)
      : new EventBus(this, "LocalEventBus", {
          eventBusName: `tenkacloud-problem-deploy-local-${cdk.Stack.of(this).stackName}`,
        });

    // [#2527 Slice 5] Subsystem: API Lambda family (SystemAuditWriter / DeployApi / EventApi /
    // DisruptionExecutor / CompetitorAccountsApi / ExternalIdAudit) + bulk payload bucket。
    const apiLambdas = buildApiLambdas(this, {
      tables,
      eventBus,
      controlDataBackendProps,
      environmentName: props.environmentName,
      defaultTenantId: props.defaultTenantId,
      problemsCatalog: props.problemsCatalog,
      problemsVisibility: props.problemsVisibility,
      problemRuntimes: props.problemRuntimes,
      challengePayloadBucketName: props.challengePayloadBucketName,
      auditLogEnabled: props.auditLogEnabled,
      deployQuotaByTier: props.deployQuotaByTier,
      cloudActionEnforcementMode: props.cloudActionEnforcementMode,
      problemsDisruptions: props.problemsDisruptions,
      problemsProvenance: props.problemsProvenance,
      useBulkDistributedMap: props.useBulkDistributedMap,
      capacityRunbookDocumentName: tables.capacityRunbookDocumentName,
      capacityRunbookAutomationRoleArn: tables.capacityRunbookAutomationRoleArn,
      deployViaLambda: props.deployViaLambda,
      // [Issue #2745] materialized problems/ tree bucket — public gcp/infra-manager Terraform read.
      sourceBucketName: props.sourceBucketName,
    });
    this.deployApiLambda = apiLambdas.deployApiFn;
    this.eventApiLambda = apiLambdas.eventApiFn;
    this.competitorAccountsApiLambda = apiLambdas.competitorAccountsApiFn;
    this.externalIdAuditLambda = apiLambdas.externalIdAuditFn;

    // Issue #2220: CodeBuild + DeployCreate/Delete state machines + Bulk Distributed Map
    // pipeline (build-deploy-pipeline.ts)。`bulkPayloadBucket` は API family 側で作られる
    // (EventApiLambda が PutObject する — bucket logical ID unchanged)。
    const deployPipeline = buildDeployPipeline(this, {
      deploymentsTable: tables.deployments?.table,
      eventBus,
      bulkPayloadBucket: apiLambdas.bulkPayloadBucket,
      sourceBucketName: props.sourceBucketName,
      sourceObjectKey: props.sourceObjectKey,
      deployConcurrentBuildLimit: props.deployConcurrentBuildLimit,
      deployAllowedCidrs: props.deployAllowedCidrs,
      environmentName: props.environmentName,
      // Issue #2291: flag OFF (default) では CodeBuild 経路のまま (追加リソースなし)。
      deployViaLambda: props.deployViaLambda,
      // Issue #2441 Phase B PR-5: pure SQL backend uses a Lambda status-writer for DeployCreate
      // SFN writeback states; dynamodb keeps native DynamoUpdateItem.
      ...controlDataBackendProps,
      // Issue #2462: active pack の実体を core problems/ の隣に materialize する (Lambda 経路のみ)。
      // undefined / 空 → BucketDeployment 追加ゼロ = CFn byte 互換。
      packAssets: props.packAssets,
    });
    this.deployCodeBuildProjectName = deployPipeline.deployCodeBuildProjectName;
    // Issue #2291: undefined on the default CodeBuild path (flag OFF) → ObservabilityStack skips the CfnDeploy Lambda widget (= default-safe, dashboard body byte-identical).
    this.cfnDeployLambdaName = deployPipeline.cfnDeployLambdaName;
    this.deployCreateStateMachineArn = deployPipeline.deployCreateStateMachineArn;
    this.deployDeleteStateMachineArn = deployPipeline.deployDeleteStateMachineArn;
    // outputs: handler refactor (= 2.C.2.b) で API Lambda が PutObject に使う。
    this.bulkDeployPayloadBucketName = deployPipeline.bulkDeployPayloadBucketName;
    this.bulkDeployCreateStateMachineArn = deployPipeline.bulkDeployCreateStateMachineArn;

    // [#2527 Slice 5] Subsystem: generic scoring dispatcher + optional ops monitoring。
    const scoring = buildScoringSubsystem(this, {
      tables,
      eventBus,
      controlDataBackendProps,
      environmentName: props.environmentName,
      problemsCatalog: props.problemsCatalog,
      problemsScoring: props.problemsScoring,
      problemsEndpoints: props.problemsEndpoints,
      problemsPhases: props.problemsPhases,
      problemsDisruptions: props.problemsDisruptions,
      problemsCoordination: props.problemsCoordination,
      problemRuntimes: props.problemRuntimes,
      opsMonitoring: props.opsMonitoring,
    });
    this.genericScoringLambda = scoring.genericScoringFn;

    // Issue #2220: portal Lambda + coordination dispatcher + CloudFront hosting, extracted to
    // build-participant-portal-subsystem.ts. Same `if (props.participantPortal)` guard as before.
    if (props.participantPortal) {
      const portalSubsystem = buildParticipantPortalSubsystem(this, {
        deploymentsTable: tables.deployments?.table,
        eventsTable: tables.events?.table,
        // Issue #2442: 純 SQL backend では table 自体が無いので undefined を渡す (env/grant/IAM を
        // ParticipantPortalLambda 側で条件化。override 読み書きは repository seam 経由)。
        endpointsTable: tables.endpoints?.table,
        problemsScoring: props.problemsScoring,
        problemsWriteups: props.problemsWriteups ?? {},
        problemsEndpoints: props.problemsEndpoints,
        problemsCoordination: props.problemsCoordination ?? {},
        problemsCoordinationBundles: props.problemsCoordinationBundles ?? {},
        environmentName: props.environmentName,
        runtimeConfig: props.participantPortal.runtimeConfig,
        region: this.region,
        // GET /portal/me/deploy-logs が この deploy CodeBuild project の build + log group を
        // read するため、 portal Lambda role へ least-privilege grant を付与する (下で構築)。
        ...(deployPipeline.deployCodeBuildProject
          ? { deployCodeBuildProject: deployPipeline.deployCodeBuildProject }
          : {}),
        // Issue #2291: deployViaLambda ON のときのみ、 Lambda 経路の deploy 進捗 (jobId stream) を
        // portal が read できるよう job log group を渡す。 flag OFF では undefined = 追加 grant/env なし。
        ...(deployPipeline.deployJobLogGroup
          ? { deployJobLogGroup: deployPipeline.deployJobLogGroup }
          : {}),
        // Issue #2440: control-plane data backend (ParticipantPortalLambda にのみ turso env/IAM
        // を展開。CoordinationDispatcher は最小 IAM を維持する)。
        ...controlDataBackendProps,
      });
      this.participantPortalLambda = portalSubsystem.participantPortalLambda;
      this.participantPortalUrl = portalSubsystem.participantPortalUrl;

      // [#2324] scoring-driven coordination tick 配線: 採点 Lambda は per-minute pass で tick
      // 対象を集め、 CoordinationDispatcher Lambda を async Invoke して plugin の runTick を最小 IAM の
      // dispatcher 内で走らせる (資格情報分離を保つ)。 採点 role が得る唯一の追加 IAM は
      // dispatcher function ARN に scope された `lambda:InvokeFunction` (= sts/ssm/kms/s3 は付与しない)。
      const dispatcher = portalSubsystem.coordinationDispatcherLambda;
      dispatcher.grantInvoke(scoring.genericScoringFn);
      scoring.genericScoringFn.addEnvironment(
        "COORDINATION_DISPATCHER_FUNCTION_NAME",
        dispatcher.functionName,
      );
    }

    new CfnOutput(this, "DeployCreateStateMachineArn", {
      value: this.deployCreateStateMachineArn,
      description: "Deploy 起動を司る Step Functions State Machine の ARN。",
    });
  }
}
