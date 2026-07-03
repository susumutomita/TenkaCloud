import * as cdk from "aws-cdk-lib";
import { CfnOutput } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { EventBus } from "aws-cdk-lib/aws-events";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { AdminAuditLogTable } from "./admin-audit-log-table.js";
import { buildDeployPipeline } from "./build-deploy-pipeline.js";
import { buildParticipantPortalSubsystem } from "./build-participant-portal-subsystem.js";
import { CompetitorAccountsApiLambda } from "./competitor-accounts-api-lambda.js";
import { CompetitorAccountsTable } from "./competitor-accounts-table.js";
import { CompetitorBootstrapHosting } from "./competitor-bootstrap-hosting.js";
import { DeployApiLambda } from "./deploy-api-lambda.js";
import { DeploymentsTable } from "./deployments-table.js";
import { DisruptionExecutorLambda } from "./disruption-executor-lambda.js";
import { DisruptionsTable } from "./disruptions-table.js";
import { EventApiLambda } from "./event-api-lambda.js";
import { EventsTable } from "./events-table.js";
import { ExternalIdAuditLambda } from "./external-id-audit-lambda.js";
import { GenericScoringLambda } from "./generic-scoring-lambda.js";
import type { ParticipantPortalRuntimeConfig } from "./participant-portal-hosting.js";
import { ProblemEndpointsTable } from "./problem-endpoints-table.js";
import { SystemAuditWriterLambda } from "./system-audit-writer-lambda.js";
import { TeamsTable } from "./teams-table.js";

export interface ProblemDeployBackendStackProps extends cdk.StackProps {
  /**
   * SBT ControlPlane の EventBus ARN。Deploy 系イベントを流す。
   *
   * Issue #778 ADR-016 Phase 2: Full mode (= ControlPlaneStack 経由) では SBT 同梱の
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
   * `problemDir` を解決する。Phase 2 (ADR-003) で DDB catalog に置換。
   */
  readonly problemsCatalog: Readonly<Record<string, string>>;
  /**
   * `problemId → scoring` の map (`{ kind: "flag", flagOutputKey, points, ... }`)。
   * Participant Portal Lambda が submit-flag 採点に使う。`scoring` を持たない問題は
   * このキーが無い (= 採点無効)。
   */
  readonly problemsScoring: Readonly<Record<string, unknown>>;
  /**
   * ADR-012 Phase 3.A: `problemId → endpoints[]` の map。`discoverProblemsEndpoints`
   * で metadata.json から自動収集して synth 時に注入する。Participant Portal の
   * `/portal/me/problems/:problemId/endpoints` route が default URL を CFn output から
   * 算出するために参照する。`endpoints[]` を持たない問題はこのキーが無い。
   */
  readonly problemsEndpoints: Readonly<Record<string, unknown>>;
  /**
   * ADR-012 Phase 3.B: `problemId → phases[]` の map。`discoverProblemsPhases` で
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
   * ADR-028/030 Phase 3 (#1420): `problemId → { plugin }` の map。 `discoverProblemsCoordination` で
   * metadata.json の `interTeamCoordination.plugin` から自動収集。 CoordinationDispatcher Lambda の
   * scope resolver が team→moduleRef を解決するのに使う。 未宣言の問題はキーが無い。
   */
  readonly problemsCoordination?: Readonly<Record<string, unknown>>;
  /**
   * ADR-030 Phase 3b (#1420): `problemId → bundledMjs`。 `bundleCoordinationPlugins` が synth 時に
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
   * Issue #2291 (ADR-049 §9): DeployCreate を CodeBuild ではなく Lambda CreateStack +
   * DescribeStacks poll 経路にするか (`CDK_PARAM_DEPLOY_VIA_LAMBDA`)。default (未指定 / false) は
   * 在来の CodeBuild 経路で、追加リソースなし = CFn テンプレ byte 互換。true で {@link CfnDeployLambda}
   * を生成し、`DeployCreate` state machine が Lambda + poll 定義に切り替わる。
   */
  readonly deployViaLambda?: boolean;
  /**
   * Issue #2311 (ADR-049 cost-zero): 監査ログ出力を on/off する。default (未指定 / true) は
   * 従来どおり監査 Lambda 群 (deploy-api / event-api / competitor-accounts-api /
   * system-audit-writer) が `writeAuditEvent` する。false のとき各 Lambda env に
   * `AUDIT_LOG_ENABLED="false"` を注入し no-op 化する (= 書き込みコスト節約)。
   */
  readonly auditLogEnabled?: boolean;
  /**
   * Issue #2290 (ADR-049 §5.1): control-plane data backend の選択 (`dynamodb` | `turso` | `sql`)。
   * event-handler の `getEventDetail` が Events / Teams repository を組み立てる cold-start factory
   * (`createEventsRepository` / `createTeamsRepository`) の seam を切替える。default (未指定 /
   * `dynamodb`) は監査 Lambda 群 (deploy-api / event-api / competitor-accounts-api /
   * system-audit-writer) の env を足さず在来 DDB 経路 (= CFn テンプレ byte 互換)。`turso` / `sql` の
   * ときだけ各 Lambda env に `CONTROL_DATA_BACKEND` を注入する。
   */
  readonly controlDataBackend?: string;
  /** Public remote libSQL URL. Required when controlDataBackend is turso/sql. */
  readonly tursoDatabaseUrl?: string;
  /** SSM SecureString parameter name containing the remote libSQL auth token. */
  readonly tursoAuthTokenParameterName?: string;
  /**
   * ADR-008 Phase 3 (Issue #642): `problemId → "private"` の map。
   * `discoverProblemsVisibility` で metadata.json から自動収集。 空 map なら全 public 扱い (dormant)。
   */
  readonly problemsVisibility?: Readonly<Record<string, "private">>;
  /**
   * [ADR-023 / #2054] `problemId → {provider,engine,entry}` (非 aws のみ)。
   * `discoverProblemsRuntime` の戻り値。deploy-handler が非 AWS 問題を cloud mutation
   * 前に拒否するための runtime catalog。 空 map なら全 AWS 扱い。
   */
  readonly problemRuntimes?: Readonly<Record<string, unknown>>;
  /**
   * ADR-008 Phase 3 (Issue #642): private 問題 payload の S3 bucket 名 (= `tc-challenges-${env}`)。
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
   * #1766: tier 別の同時デプロイ上限。DeployApi Lambda の `DEPLOY_QUOTA_BY_TIER` env (JSON)
   * に渡す。未設定ならクォータ無効 (= 在来挙動 / Lite mode)。
   */
  readonly deployQuotaByTier?: {
    readonly basic: number;
    readonly advanced: number;
    readonly platinum: number;
  };
  /**
   * Issue #2019 / ADR-017: TrustBridge high-risk enforcement mode for the deploy
   * Lambda (`CLOUD_ACTION_ENFORCEMENT_MODE` env)。 default `"shadow"` (= 既存挙動、
   * 全 deploy が従来経路で CFn diff も無し)。 `"enforce"` で opt-in: 高リスク deploy
   * (= 既存ライブスタックを置換する deploy) を `APPROVAL_PENDING` で保留し、 AssumeRole /
   * CloudFormation を走らせない。
   */
  readonly cloudActionEnforcementMode?: "shadow" | "enforce";
  /**
   * SSM SecureString path 構築用の environment 名 (Issue #459 / ADR-002 Phase 2.1)。
   * `/{environmentName}/tenants/{tenantId}/external-id` の prefix として使う。
   * 例: `development` / `staging` / `production`。
   */
  readonly environmentName: string;
}

/**
 * 問題 deploy backend のスタック (MVP-1 / ADR-001 PR-2)。
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
   * Event / Team CRUD 用の Lambda (ADR-004 Phase 1)。tenant API から invoke される。
   */
  public readonly eventApiLambda: IFunction;
  /**
   * Competitor Accounts CRUD + verify 用 Lambda (Issue #459 / ADR-002 Phase 2.1)。
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
   * Deployments table (ADR-011 #590 で AdminConsoleInsightStack が read-only に
   * 跨ぐため公開)。grantReadData は呼び出し側で行う。
   */
  public readonly deploymentsTable: Table;
  /** Events table (ADR-011 #590 で AdminConsoleInsightStack が cross-stack read する)。 */
  public readonly eventsTable: Table;
  /**
   * Teams table (ADR-011 Phase 1.B 以降で drill-down 用に読む)。Phase 1.A では
   * 参照のみ (read 権限は付与しない)。
   */
  public readonly teamsTable: Table;
  /** CompetitorAccounts table name is surfaced to ObservabilityStack metrics. */
  public readonly competitorAccountsTable: Table;
  /** ProblemEndpoints table name is surfaced to ObservabilityStack metrics. */
  public readonly problemEndpointsTable: Table;
  /**
   * Issue #950 (ADR-020 Phase D): admin audit log table。 AdminConsoleInsightStack が
   * cross-stack read で audit UI に出すため公開する (= read-only)。
   */
  public readonly adminAuditLogTable: Table;
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
  public readonly deployCodeBuildProjectName: string;
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

    const deployments = new DeploymentsTable(this, "Deployments");
    // ADR-004 Phase 1: Event / Team の 2 Table を Deployments と並列に持つ。
    // Phase 2 で Bulk Deploy / Bulk Teardown を State Machine 経由で動かす。
    const events = new EventsTable(this, "Events");
    const teams = new TeamsTable(this, "Teams");
    // ADR-012 Phase 3.A: Endpoint registry。per (tenant, team, problem, slot) で override
    // URL を保管する。default URL は read-through で deployment.stackOutputs から算出。
    const endpoints = new ProblemEndpointsTable(this, "ProblemEndpoints");
    // ADR-011 #590: AdminConsoleInsightStack に cross-stack で渡すため expose する。
    this.deploymentsTable = deployments.table;
    this.eventsTable = events.table;
    this.teamsTable = teams.table;
    // Issue #459 / ADR-002 Phase 2.1: tenant ↔ 競技者 AWS account の許可表。
    // 1 行 = 1 (tenantId, awsAccountId)。verified=false は deploy 不可。
    const competitorAccounts = new CompetitorAccountsTable(this, "CompetitorAccounts");
    this.competitorAccountsTable = competitorAccounts.table;
    this.problemEndpointsTable = endpoints.table;
    // Issue #888: Red Team Disruption Injection の audit log + idempotency
    const disruptions = new DisruptionsTable(this, "Disruptions");
    // Issue #950 (ADR-020 Phase D): admin 操作の append-only 監査ログ。 3 handler Lambda +
    // admin-insight Lambda が PutItem する。 TTL 90 日で自動 GC (= env `AUDIT_RETENTION_DAYS`
    // で 365 / SOC2 enterprise 用に上げる)。
    const adminAuditLog = new AdminAuditLogTable(this, "AdminAuditLog");
    this.adminAuditLogTable = adminAuditLog.table;

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
    // Issue #778 ADR-016 Phase 2: eventBusArn が渡されていれば既存の SBT bus を import、
    // 渡されていなければ Lite mode と判定して local EventBus を新規に作る。 後者では Step
    // Functions Rule も local bus にぶら下がるため、 cross-stack 依存が増えない。
    const eventBus = props.eventBusArn
      ? EventBus.fromEventBusArn(this, "ImportedEventBus", props.eventBusArn)
      : new EventBus(this, "LocalEventBus", {
          eventBusName: `tenkacloud-problem-deploy-local-${cdk.Stack.of(this).stackName}`,
        });

    // Issue #1034: SBT Control Plane が発する onboarding* / offboarding* event を audit に集約。
    // SystemAdmin の tenant CRUD は SBT 経由なので App Plane Lambda が走らず、 audit-log page の
    // SystemAdmin scope が常に空になっていた。 本 listener が SBT bus 上の 6 detailType を catch して
    // `PK=SYSTEM#<env>` 行を書く。 Lite mode (= ControlPlane 不在) では local bus にぶら下がるが、
    // SBT events も流れて来ない (= 副作用なし) ため idle で安全。
    new SystemAuditWriterLambda(this, "SystemAuditWriter", {
      eventBus,
      adminAuditLogTable: adminAuditLog.table,
      environmentName: props.environmentName,
      // Issue #2311: 監査ログ feature flag (off で writeAuditEvent が no-op)。
      auditLogEnabled: props.auditLogEnabled,
      // Issue #2290: control-plane data backend (default dynamodb は env を足さず byte 互換)。
      controlDataBackend: props.controlDataBackend,
      // Issue #2291: Lambda deploy 経路のとき、失敗 event を拾う DeployFailureRule を有効化
      // (= CodeBuild path の CodeBuild FAILED audit と parity)。flag OFF では Rule なし = byte 互換。
      deployViaLambda: props.deployViaLambda,
    });

    // tenant API から invoke される Lambda。validation + DDB Put + EventBridge PutEvents のみ。
    // Phase 2.2 (Issue #459): CompetitorAccounts table + env を渡して verified-only gate を有効化。
    const deployApi = new DeployApiLambda(this, "DeployApi", {
      deploymentsTable: deployments.table,
      competitorAccountsTable: competitorAccounts.table,
      eventBus,
      defaultTenantId: props.defaultTenantId,
      problemsCatalog: props.problemsCatalog,
      // ADR-008 Phase 3 (Issue #642): visibility + bucket、 unset で dormant default。
      problemsVisibility: props.problemsVisibility ?? {},
      // [ADR-023 / #2054] 非 AWS 問題を cloud mutation 前に拒否する runtime catalog
      // (= DeployApiLambda の optional prop。 undefined は env 側 `?? {}` で空 map に正規化)。
      problemRuntimes: props.problemRuntimes,
      ...(props.challengePayloadBucketName
        ? { challengePayloadBucketName: props.challengePayloadBucketName }
        : {}),
      environmentName: props.environmentName,
      // Issue #950 (ADR-020 Phase D): admin audit log を write
      adminAuditLogTable: adminAuditLog.table,
      // Issue #2311: 監査ログ feature flag。
      auditLogEnabled: props.auditLogEnabled,
      // Issue #2290: control-plane data backend (default dynamodb は env を足さず byte 互換)。
      controlDataBackend: props.controlDataBackend,
      // #1766: tier 別の同時デプロイ上限 (env JSON)。
      deployQuotaByTier: props.deployQuotaByTier,
      // Issue #2019 / ADR-017: TrustBridge enforcement mode (undefined → lambda
      // defaults to shadow = no-op)。
      cloudActionEnforcementMode: props.cloudActionEnforcementMode,
    });
    this.deployApiLambda = deployApi.fn;

    // Issue #910 (#895 Phase 2.C.2.b): bulk batch payload S3 bucket。 EventApiLambda の
    // bulk-deploy handler が PutObject で deployment 配列を書く。 default では feature flag
    // off で旧 fan-out 維持、 flag flip で Distributed Map 経路 (= 後段 BulkDeployCreateStateMachine)
    // に切替。 bucket 自体は flag に関係なく作る (= flip だけで切替可能、 段階移行)。
    const bulkPayloadBucket = new Bucket(this, "BulkDeployPayloadBucket", {
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // 旧 batch の object はもう不要なので 7 日で自動削除 (= cost / GC)。
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(7),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
    });

    // ADR-004 Phase 1+2a: Event / Team CRUD + Bulk Deploy/Teardown Lambda。
    // Phase 2a で deployment 行の作成 / status 更新 + EventBridge fan-out publish を担う。
    // Phase 2.2 (Issue #459): CompetitorAccounts table + env を渡して verified-only gate を有効化。
    const eventApi = new EventApiLambda(this, "EventApi", {
      eventsTable: events.table,
      teamsTable: teams.table,
      deploymentsTable: deployments.table,
      competitorAccountsTable: competitorAccounts.table,
      eventBus,
      problemsCatalog: props.problemsCatalog,
      defaultTenantId: props.defaultTenantId,
      environmentName: props.environmentName,
      // Issue #888: disruption fire / audit / catalog で参照
      disruptionsTable: disruptions.table,
      problemsDisruptions: (props.problemsDisruptions ?? {}) as Readonly<
        Record<string, readonly unknown[]>
      >,
      // Issue #910 Phase 2.C.2.b: bulk batch payload bucket + feature flag。
      bulkDeployPayloadBucket: bulkPayloadBucket,
      useBulkDistributedMap: props.useBulkDistributedMap ?? false,
      // Issue #950
      adminAuditLogTable: adminAuditLog.table,
      // Issue #2311: 監査ログ feature flag。
      auditLogEnabled: props.auditLogEnabled,
      // Issue #2290: control-plane data backend。event-handler の getEventDetail が Events / Teams
      // repository seam を切替える (= turso/sql 選択時のみ CONTROL_DATA_BACKEND を注入)。
      controlDataBackend: props.controlDataBackend,
      tursoDatabaseUrl: props.tursoDatabaseUrl,
      tursoAuthTokenParameterName: props.tursoAuthTokenParameterName,
    });
    this.eventApiLambda = eventApi.fn;

    // [ADR-031 / Issue #1419] Disruption Phase B: operator fire が publish した `*DisruptionFired` を
    // 拾い、 team deployment へ AssumeRole して実障害を注入し、 revert を予約する cross-account executor。
    // action 未宣言の disruption は no-op (= Phase A 監査のみ、 後方互換)。
    new DisruptionExecutorLambda(this, "DisruptionExecutor", {
      environmentName: props.environmentName,
      eventBus,
      deploymentsTable: deployments.table,
      disruptionsTable: disruptions.table,
      problemsDisruptions: (props.problemsDisruptions ?? {}) as Readonly<Record<string, unknown>>,
    });

    // Issue #459 / ADR-002 Phase 2.1: Competitor Accounts CRUD + STS verify Lambda。
    // 独立 Lambda にする理由: SSM SecureString R/W + STS AssumeRole の IAM scope を最小化するため。
    const competitorAccountsApi = new CompetitorAccountsApiLambda(this, "CompetitorAccountsApi", {
      competitorAccountsTable: competitorAccounts.table,
      environmentName: props.environmentName,
      // Issue #950
      adminAuditLogTable: adminAuditLog.table,
      // Issue #2311: 監査ログ feature flag。
      auditLogEnabled: props.auditLogEnabled,
      // Issue #2290: control-plane data backend (default dynamodb は env を足さず byte 互換)。
      controlDataBackend: props.controlDataBackend,
    });
    this.competitorAccountsApiLambda = competitorAccountsApi.fn;

    // Issue #2220: CodeBuild + DeployCreate/Delete state machines + Bulk Distributed Map
    // pipeline, extracted to build-deploy-pipeline.ts. `bulkPayloadBucket` stays here (also
    // used by EventApiLambda above, wired before this pipeline — bucket logical ID unchanged).
    const deployPipeline = buildDeployPipeline(this, {
      deploymentsTable: deployments.table,
      eventBus,
      bulkPayloadBucket,
      sourceBucketName: props.sourceBucketName,
      sourceObjectKey: props.sourceObjectKey,
      deployConcurrentBuildLimit: props.deployConcurrentBuildLimit,
      environmentName: props.environmentName,
      // Issue #2291: flag OFF (default) では CodeBuild 経路のまま (追加リソースなし)。
      deployViaLambda: props.deployViaLambda,
    });
    this.deployCodeBuildProjectName = deployPipeline.deployCodeBuildProjectName;
    this.deployCreateStateMachineArn = deployPipeline.deployCreateStateMachineArn;
    this.deployDeleteStateMachineArn = deployPipeline.deployDeleteStateMachineArn;
    // outputs: handler refactor (= 2.C.2.b) で API Lambda が PutObject に使う。
    this.bulkDeployPayloadBucketName = deployPipeline.bulkDeployPayloadBucketName;
    this.bulkDeployCreateStateMachineArn = deployPipeline.bulkDeployCreateStateMachineArn;

    // ADR-012 Phase 3.B: 1 分間隔の Generic Scoring Lambda (= 旧 HealthCheckLambda の後継)。
    // 2 つの責務を持つ:
    // - 採点 dispatch (= 5 種 builtin kind の handler に dispatch、`flag` は polling では no-op)
    // - Event status auto-transition (#557 #539): DEPLOYING→READY / TEARDOWN→ARCHIVED
    //
    // uptime 問題が無い tenant でも reconcile は要るので **常に instantiate** (= 旧
    // `if (problemsScoring.length > 0)` ガードは撤去のまま継続)。
    const genericScoring = new GenericScoringLambda(this, "GenericScoring", {
      deploymentsTable: deployments.table,
      eventsTable: events.table,
      endpointsTable: endpoints.table,
      problemsScoring: props.problemsScoring,
      problemsEndpoints: props.problemsEndpoints,
      problemsPhases: props.problemsPhases ?? {},
      // #1422 (ADR-013 Phase 2): condition-triggered disruption の eval + in-account 発火。
      problemsDisruptions: props.problemsDisruptions ?? {},
      // [ADR-028 / #2324] scoring-driven coordination tick 用の宣言 config (= どの problemId が
      // coordination を宣言しているか、 plugin code ではない metadata)。 per-minute pass が tick 対象を
      // 判定し、 実 runTick は最小 IAM の CoordinationDispatcher Lambda へ Invoke で委ねる (下で配線)。
      problemsCoordination: props.problemsCoordination ?? {},
      // [ADR-033 / #1665] operator-fired disruption の active 採点効果を tick で解決する (read-only)。
      disruptionsTable: disruptions.table,
      // [ADR-047] scheduled auto-teardown が bulkTeardownEvent で cross-account role を解決する (read-only)。
      competitorAccountsTable: competitorAccounts.table,
      // [ADR-047 follow-up] scheduled auto-deploy が bulkDeployEvent で teams を Query (read-only) +
      // catalog で problemId→problemDir を解決する。
      teamsTable: teams.table,
      problemsCatalog: props.problemsCatalog,
      eventBus,
      // [ADR-026/027/032 / #1410-1412] 非 AWS runtime status reconciler の credential path 構築用。
      environmentName: props.environmentName,
    });
    this.genericScoringLambda = genericScoring.fn;

    // Phase 3.2 / Issue #603: ExternalId rotation age 監査 Lambda。1 日 1 回起動して
    // CompetitorAccounts table を Scan し、各 (tenantId, awsAccountId) の rotation age を
    // CloudWatch メトリクス `TenkaCloud/CompetitorAccounts/RotationAge` に publish する。
    // SSM Parameter Store は 100 version で auto-drop するため明示的な cleanup Lambda は
    // 入れない (= 説明は `external-id-audit-lambda.ts` の docblock を参照)。
    const externalIdAudit = new ExternalIdAuditLambda(this, "ExternalIdAudit", {
      competitorAccountsTable: competitorAccounts.table,
      environmentName: props.environmentName,
    });
    this.externalIdAuditLambda = externalIdAudit.fn;

    // Issue #2220: portal Lambda + coordination dispatcher + CloudFront hosting, extracted to
    // build-participant-portal-subsystem.ts. Same `if (props.participantPortal)` guard as before.
    if (props.participantPortal) {
      const portalSubsystem = buildParticipantPortalSubsystem(this, {
        deploymentsTable: deployments.table,
        eventsTable: events.table,
        endpointsTable: endpoints.table,
        problemsScoring: props.problemsScoring,
        problemsEndpoints: props.problemsEndpoints,
        problemsCoordination: props.problemsCoordination ?? {},
        problemsCoordinationBundles: props.problemsCoordinationBundles ?? {},
        environmentName: props.environmentName,
        runtimeConfig: props.participantPortal.runtimeConfig,
        region: this.region,
        // GET /portal/me/deploy-logs が この deploy CodeBuild project の build + log group を
        // read するため、 portal Lambda role へ least-privilege grant を付与する (下で構築)。
        deployCodeBuildProject: deployPipeline.deployCodeBuildProject,
        // Issue #2291: deployViaLambda ON のときのみ、 Lambda 経路の deploy 進捗 (jobId stream) を
        // portal が read できるよう job log group を渡す。 flag OFF では undefined = 追加 grant/env なし。
        ...(deployPipeline.deployJobLogGroup
          ? { deployJobLogGroup: deployPipeline.deployJobLogGroup }
          : {}),
      });
      this.participantPortalLambda = portalSubsystem.participantPortalLambda;
      this.participantPortalUrl = portalSubsystem.participantPortalUrl;

      // [ADR-028 / #2324] scoring-driven coordination tick 配線: 採点 Lambda は per-minute pass で tick
      // 対象を集め、 CoordinationDispatcher Lambda を async Invoke して plugin の runTick を最小 IAM の
      // dispatcher 内で走らせる (= ADR-028/030 の資格情報分離を保つ)。 採点 role が得る唯一の追加 IAM は
      // dispatcher function ARN に scope された `lambda:InvokeFunction` (= sts/ssm/kms/s3 は付与しない)。
      const dispatcher = portalSubsystem.coordinationDispatcherLambda;
      dispatcher.grantInvoke(genericScoring.fn);
      genericScoring.fn.addEnvironment(
        "COORDINATION_DISPATCHER_FUNCTION_NAME",
        dispatcher.functionName,
      );
    }

    new CfnOutput(this, "DeploymentsTableName", {
      value: deployments.table.tableName,
      description: "Deploy ジョブを記録する DynamoDB テーブル名。",
    });
    new CfnOutput(this, "EventsTableName", {
      value: events.table.tableName,
      description: "ADR-004 Events table 名 (1 競技イベント = 1 行)。",
    });
    new CfnOutput(this, "TeamsTableName", {
      value: teams.table.tableName,
      description: "ADR-004 Teams table 名 (1 チーム = 1 行、teamLoginKey は team scope)。",
    });
    new CfnOutput(this, "CompetitorAccountsTableName", {
      value: competitorAccounts.table.tableName,
      description:
        "Issue #459 / ADR-002 Competitor Accounts table 名 (tenant ↔ 競技者 AWS account 紐付け)。",
    });
    new CfnOutput(this, "DeployCreateStateMachineArn", {
      value: this.deployCreateStateMachineArn,
      description: "Deploy 起動を司る Step Functions State Machine の ARN。",
    });
    new CfnOutput(this, "ProblemEndpointsTableName", {
      value: endpoints.table.tableName,
      description:
        "ADR-012 Phase 3.A Endpoint registry table 名 (per (tenant, team, problem, slot) の override 行)。",
    });
  }
}
