import * as cdk from "aws-cdk-lib";
import { CfnOutput } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { EventBus } from "aws-cdk-lib/aws-events";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { ConsoleViewerRole } from "./console-viewer-role";
import { DeployApiLambda } from "./deploy-api-lambda";
import { DeployCodeBuildProject } from "./deploy-codebuild-project";
import { DeployCreateStateMachine } from "./deploy-create-state-machine";
import { DeployDeleteStateMachine } from "./deploy-delete-state-machine";
import { DeployDeleteEventRule, DeployEventRule } from "./deploy-event-rule";
import { DeploymentsTable } from "./deployments-table";
import { EventApiLambda } from "./event-api-lambda";
import { EventsTable } from "./events-table";
import { HealthCheckLambda } from "./health-check-lambda";
import {
  DEFAULT_DEV_MOCK_RUNTIME_CONFIG,
  ParticipantPortalHosting,
  type ParticipantPortalRuntimeConfig,
} from "./participant-portal-hosting";
import { ParticipantPortalLambda } from "./participant-portal-lambda";
import { TeamsTable } from "./teams-table";

export interface ProblemDeployBackendStackProps extends cdk.StackProps {
  /** SBT ControlPlane の EventBus ARN。Deploy 系イベントを流す。 */
  readonly eventBusArn: string;
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

  constructor(scope: Construct, id: string, props: ProblemDeployBackendStackProps) {
    super(scope, id, props);

    const deployments = new DeploymentsTable(this, "Deployments");
    // ADR-004 Phase 1: Event / Team の 2 Table を Deployments と並列に持つ。
    // Phase 2 で Bulk Deploy / Bulk Teardown を State Machine 経由で動かす。
    const events = new EventsTable(this, "Events");
    const teams = new TeamsTable(this, "Teams");
    // ADR-011 #590: AdminConsoleInsightStack に cross-stack で渡すため expose する。
    this.deploymentsTable = deployments.table;
    this.eventsTable = events.table;
    this.teamsTable = teams.table;
    const eventBus = EventBus.fromEventBusArn(this, "ImportedEventBus", props.eventBusArn);

    // tenant API から invoke される Lambda。validation + DDB Put + EventBridge PutEvents のみ。
    const deployApi = new DeployApiLambda(this, "DeployApi", {
      deploymentsTable: deployments.table,
      eventBus,
      defaultTenantId: props.defaultTenantId,
      problemsCatalog: props.problemsCatalog,
    });
    this.deployApiLambda = deployApi.fn;

    // ADR-004 Phase 1+2a: Event / Team CRUD + Bulk Deploy/Teardown Lambda。
    // Phase 2a で deployment 行の作成 / status 更新 + EventBridge fan-out publish を担う。
    const eventApi = new EventApiLambda(this, "EventApi", {
      eventsTable: events.table,
      teamsTable: teams.table,
      deploymentsTable: deployments.table,
      eventBus,
      problemsCatalog: props.problemsCatalog,
      defaultTenantId: props.defaultTenantId,
    });
    this.eventApiLambda = eventApi.fn;

    // CodeBuild Project: source.zip から `scripts/deploy-battles.sh` を実行する。
    // #538: Bulk Deploy 並列度の hard cap は account-wide CodeBuild concurrent build
    // quota (region default 60)。本 prop で project 単位に明示 cap を指定できる
    // (= operator が Service Quota を引き上げた値を伝える経路 / sandbox で暴走防止)。
    const sourceBucket = Bucket.fromBucketName(this, "SourceBucket", props.sourceBucketName);
    const codeBuild = new DeployCodeBuildProject(this, "DeployCodeBuild", {
      sourceBucket,
      sourceObjectKey: props.sourceObjectKey,
      concurrentBuildLimit: props.deployConcurrentBuildLimit,
    });

    const stateMachine = new DeployCreateStateMachine(this, "DeployCreate", {
      codeBuildProject: codeBuild.project,
      deploymentsTable: deployments.table,
    });

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
    new DeployDeleteEventRule(this, "DeployDeleteRule", {
      eventBus,
      stateMachine: deleteStateMachine.stateMachine,
    });

    // 1 分間隔の Health Check Lambda は 2 つの責務を持つ:
    // - uptime 採点 (`scoring.kind=uptime` の問題のみ)。`flag` 形式は Portal Lambda の
    //   submit-flag 経路で採点するため別系統。
    // - Event status auto-transition (#557 #539): DEPLOYING→READY / TEARDOWN→ARCHIVED。
    //   uptime 問題が無い tenant でも reconcile は要るので **常に instantiate** (= 旧
    //   `if (problemsScoring.length > 0)` ガードは撤去)。
    new HealthCheckLambda(this, "HealthCheck", {
      deploymentsTable: deployments.table,
      eventsTable: events.table,
      problemsScoring: props.problemsScoring,
    });

    if (props.participantPortal) {
      const consoleViewerRole = new ConsoleViewerRole(this, "ConsoleViewerRole");
      const portalLambda = new ParticipantPortalLambda(this, "ParticipantPortalLambda", {
        deploymentsTable: deployments.table,
        eventsTable: events.table,
        problemsScoring: props.problemsScoring,
        consoleViewerRoleArn: consoleViewerRole.role.roleArn,
      });
      // Lambda role に AssumeRole 権限を付与 (= federation flow の前提)。
      consoleViewerRole.role.grantAssumeRole(portalLambda.fn.grantPrincipal);
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
    new CfnOutput(this, "DeployCreateStateMachineArn", {
      value: stateMachine.stateMachine.stateMachineArn,
      description: "Deploy 起動を司る Step Functions State Machine の ARN。",
    });
  }
}
