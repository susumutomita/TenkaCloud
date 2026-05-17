import * as cdk from "aws-cdk-lib";
import { CfnOutput } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { EventBus } from "aws-cdk-lib/aws-events";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { BulkDeployCreateStateMachine } from "./bulk-deploy-create-state-machine";
import { CompetitorAccountsApiLambda } from "./competitor-accounts-api-lambda";
import { CompetitorAccountsTable } from "./competitor-accounts-table";
import { DeployApiLambda } from "./deploy-api-lambda";
import { DeployCodeBuildProject } from "./deploy-codebuild-project";
import { DeployCreateStateMachine } from "./deploy-create-state-machine";
import { DeployDeleteStateMachine } from "./deploy-delete-state-machine";
import {
  BulkDeployCreateEventRule,
  DeployDeleteEventRule,
  DeployEventRule,
} from "./deploy-event-rule";
import { DeploymentsTable } from "./deployments-table";
import { DescribeStackLambda } from "./describe-stack-lambda";
import { DisruptionsTable } from "./disruptions-table";
import { EventApiLambda } from "./event-api-lambda";
import { EventsTable } from "./events-table";
import { ExternalIdAuditLambda } from "./external-id-audit-lambda";
import { GenericScoringLambda } from "./generic-scoring-lambda";
import {
  DEFAULT_DEV_MOCK_RUNTIME_CONFIG,
  ParticipantPortalHosting,
  type ParticipantPortalRuntimeConfig,
} from "./participant-portal-hosting";
import { ParticipantPortalLambda } from "./participant-portal-lambda";
import { ProblemEndpointsTable } from "./problem-endpoints-table";
import { TeamsTable } from "./teams-table";

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
   * ADR-008 Phase 3 (Issue #642): `problemId → "private"` の map。
   * `discoverProblemsVisibility` で metadata.json から自動収集。 空 map なら全 public 扱い (dormant)。
   */
  readonly problemsVisibility?: Readonly<Record<string, "private">>;
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
    // Issue #778 ADR-016 Phase 2: eventBusArn が渡されていれば既存の SBT bus を import、
    // 渡されていなければ Lite mode と判定して local EventBus を新規に作る。 後者では Step
    // Functions Rule も local bus にぶら下がるため、 cross-stack 依存が増えない。
    const eventBus = props.eventBusArn
      ? EventBus.fromEventBusArn(this, "ImportedEventBus", props.eventBusArn)
      : new EventBus(this, "LocalEventBus", {
          eventBusName: `tenkacloud-problem-deploy-local-${cdk.Stack.of(this).stackName}`,
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
      ...(props.challengePayloadBucketName
        ? { challengePayloadBucketName: props.challengePayloadBucketName }
        : {}),
      environmentName: props.environmentName,
    });
    this.deployApiLambda = deployApi.fn;

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
    });
    this.eventApiLambda = eventApi.fn;

    // Issue #459 / ADR-002 Phase 2.1: Competitor Accounts CRUD + STS verify Lambda。
    // 独立 Lambda にする理由: SSM SecureString R/W + STS AssumeRole の IAM scope を最小化するため。
    const competitorAccountsApi = new CompetitorAccountsApiLambda(this, "CompetitorAccountsApi", {
      competitorAccountsTable: competitorAccounts.table,
      environmentName: props.environmentName,
    });
    this.competitorAccountsApiLambda = competitorAccountsApi.fn;

    // CodeBuild Project: source.zip から `scripts/deploy-battles.sh` を実行する。
    // #538: Bulk Deploy 並列度の hard cap は account-wide CodeBuild concurrent build
    // quota (region default 60)。本 prop で project 単位に明示 cap を指定できる
    // (= operator が Service Quota を引き上げた値を伝える経路 / sandbox で暴走防止)。
    const sourceBucket = Bucket.fromBucketName(this, "SourceBucket", props.sourceBucketName);
    const codeBuild = new DeployCodeBuildProject(this, "DeployCodeBuild", {
      sourceBucket,
      sourceObjectKey: props.sourceObjectKey,
      concurrentBuildLimit: props.deployConcurrentBuildLimit,
      environmentName: props.environmentName,
    });
    this.deployCodeBuildProjectName = codeBuild.project.projectName;

    const describeStack = new DescribeStackLambda(this, "DescribeStack", {
      environmentName: props.environmentName,
    });

    const stateMachine = new DeployCreateStateMachine(this, "DeployCreate", {
      codeBuildProject: codeBuild.project,
      describeStackFunction: describeStack.fn,
      deploymentsTable: deployments.table,
    });
    this.deployCreateStateMachineArn = stateMachine.stateMachine.stateMachineArn;

    // EventBridge Rule: `DeployCreateRequested` event を State Machine に流す。
    new DeployEventRule(this, "DeployCreateRule", {
      eventBus,
      stateMachine: stateMachine.stateMachine,
    });

    // 削除経路 (deploy 対称): `DeployDeleteRequested` → DeployDelete State Machine →
    // 同 CodeBuild Project (`OPERATION=delete`) → `scripts/delete-battles.sh` → CFn DeleteStack。
    // State Machine 完了で DDB の status を `DELETING` → `DELETED` / `FAILED` に書き戻す。
    const deleteStateMachine = new DeployDeleteStateMachine(this, "DeployDelete", {
      codeBuildProject: codeBuild.project,
      deploymentsTable: deployments.table,
    });
    this.deployDeleteStateMachineArn = deleteStateMachine.stateMachine.stateMachineArn;
    new DeployDeleteEventRule(this, "DeployDeleteRule", {
      eventBus,
      stateMachine: deleteStateMachine.stateMachine,
    });

    // Issue #910 (#895 Phase 2.C): bulk batch (= 750 deployments) を Distributed Map で
    // 並列実行するための State Machine + S3 Bucket + EventBridge Rule。 Phase 2.C.2.a
    // 段階では bulk-deploy.ts handler はまだこの経路を使わない (= 旧 fan-out が継続)。
    // 後続 PR (2.C.2.b) で handler を S3 PutObject + 1 BulkDeployCreateRequested publish
    // に切替える。
    const bulkPayloadBucket = new Bucket(this, "BulkDeployPayloadBucket", {
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // 旧 batch の object はもう不要なので 7 日で自動削除 (= cost / GC)。 retry API は
      // jobId 単位で再投入する (= retry 経路で再 PutObject)、 batch object 自体は短命。
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(7),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
    });
    const bulkStateMachine = new BulkDeployCreateStateMachine(this, "BulkDeployCreate", {
      childStateMachine: stateMachine.stateMachine,
      payloadBucket: bulkPayloadBucket,
    });
    new BulkDeployCreateEventRule(this, "BulkDeployCreateRule", {
      eventBus,
      stateMachine: bulkStateMachine.stateMachine,
    });
    // outputs: handler refactor (= 2.C.2.b) で API Lambda が PutObject に使う。
    this.bulkDeployPayloadBucketName = bulkPayloadBucket.bucketName;
    this.bulkDeployCreateStateMachineArn = bulkStateMachine.stateMachine.stateMachineArn;

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

    if (props.participantPortal) {
      const portalLambda = new ParticipantPortalLambda(this, "ParticipantPortalLambda", {
        deploymentsTable: deployments.table,
        eventsTable: events.table,
        endpointsTable: endpoints.table,
        problemsScoring: props.problemsScoring,
        problemsEndpoints: props.problemsEndpoints,
        environmentName: props.environmentName,
      });
      this.participantPortalLambda = portalLambda.fn;
      new CfnOutput(this, "ParticipantPortalApiUrl", {
        value: portalLambda.url.url,
        description: "Participant Portal Lambda Function URL (auth via teamLoginKey bearer).",
      });

      const portal = new ParticipantPortalHosting(this, "ParticipantPortal");
      const baseConfig =
        props.participantPortal.runtimeConfig === "default-dev-mock"
          ? DEFAULT_DEV_MOCK_RUNTIME_CONFIG(this.region)
          : props.participantPortal.runtimeConfig;
      portal.deployRuntimeConfig({
        ...baseConfig,
        apiBaseUrl: portalLambda.url.url,
        mode: "backend",
      });
      this.participantPortalUrl = portal.distributionUrl;
      new CfnOutput(this, "ParticipantPortalUrl", {
        value: portal.distributionUrl,
        description: "Participant Portal CloudFront URL.",
      });
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
      value: stateMachine.stateMachine.stateMachineArn,
      description: "Deploy 起動を司る Step Functions State Machine の ARN。",
    });
    new CfnOutput(this, "ProblemEndpointsTableName", {
      value: endpoints.table.tableName,
      description:
        "ADR-012 Phase 3.A Endpoint registry table 名 (per (tenant, team, problem, slot) の override 行)。",
    });
  }
}
