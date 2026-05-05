import * as cdk from "aws-cdk-lib";
import { CfnOutput } from "aws-cdk-lib";
import { EventBus } from "aws-cdk-lib/aws-events";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import type { IStateMachine } from "aws-cdk-lib/aws-stepfunctions";
import type { Construct } from "constructs";
import { DeployApiLambda } from "./deploy-api-lambda";
import { DeployCodeBuildProject } from "./deploy-codebuild-project";
import { DeployCreateStateMachine } from "./deploy-create-state-machine";
import { DeployEventRule } from "./deploy-event-rule";
import { DeploymentsTable } from "./deployments-table";
import {
  DEFAULT_DEV_MOCK_RUNTIME_CONFIG,
  ParticipantPortalHosting,
  type ParticipantPortalRuntimeConfig,
} from "./participant-portal-hosting";
import { ParticipantPortalLambda } from "./participant-portal-lambda";

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
   * `problemId → problemDir` の hard-coded 問題カタログ (MVP-1)。`problems/sample/hello-world` 等。
   * tenant API Lambda の env に injected され、deploy 起動時に State Machine 入力の
   * `problemDir` を解決する。Phase 2 (ADR-003) で DDB catalog に置換。
   */
  readonly problemsCatalog: Readonly<Record<string, string>>;
  /**
   * 競技者向け Participant Portal を S3 + CloudFront で配信する。指定された
   * `runtimeConfig` が runtime-config.json として配置される。Portal backend が
   * 無い段階では `runtimeConfig: "default-dev-mock"` を渡せば mode="dev-mock"
   * のサンプル値で起動する (frontend 単体動作)。未指定なら Portal Hosting を作らない。
   */
  readonly participantPortal?: {
    readonly runtimeConfig: ParticipantPortalRuntimeConfig | "default-dev-mock";
  };
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
  public readonly deploymentsTableName: string;
  public readonly deploymentsTableArn: string;
  /** tenant API から `LambdaIntegration` で invoke される Lambda。 */
  public readonly deployApiLambda: IFunction;
  public readonly deployCreateStateMachine: IStateMachine;
  public readonly participantPortalUrl?: string;
  public readonly participantPortalApiUrl?: string;

  constructor(scope: Construct, id: string, props: ProblemDeployBackendStackProps) {
    super(scope, id, props);

    const deployments = new DeploymentsTable(this, "Deployments");
    const eventBus = EventBus.fromEventBusArn(this, "ImportedEventBus", props.eventBusArn);

    // tenant API から invoke される Lambda。validation + DDB Put + EventBridge PutEvents のみ。
    const deployApi = new DeployApiLambda(this, "DeployApi", {
      deploymentsTable: deployments.table,
      eventBus,
      defaultTenantId: props.defaultTenantId,
      problemsCatalog: props.problemsCatalog,
    });
    this.deployApiLambda = deployApi.fn;

    // CodeBuild Project: source.zip から `scripts/deploy-battles.sh` を実行する。
    const sourceBucket = Bucket.fromBucketName(this, "SourceBucket", props.sourceBucketName);
    const codeBuild = new DeployCodeBuildProject(this, "DeployCodeBuild", {
      sourceBucket,
      sourceObjectKey: props.sourceObjectKey,
    });

    // Step Functions: CodeBuildStartBuild を `.sync` で起動。
    const stateMachine = new DeployCreateStateMachine(this, "DeployCreate", {
      codeBuildProject: codeBuild.project,
    });
    this.deployCreateStateMachine = stateMachine.stateMachine;

    // EventBridge Rule: `DeployCreateRequested` event を State Machine に流す。
    new DeployEventRule(this, "DeployCreateRule", {
      eventBus,
      stateMachine: stateMachine.stateMachine,
    });

    if (props.participantPortal) {
      const portalLambda = new ParticipantPortalLambda(this, "ParticipantPortalLambda", {
        deploymentsTable: deployments.table,
      });
      this.participantPortalApiUrl = portalLambda.url.url;
      new CfnOutput(this, "ParticipantPortalApiUrl", {
        value: portalLambda.url.url,
        description: "Participant Portal Lambda Function URL (auth via teamLoginKey bearer).",
      });

      const portal = new ParticipantPortalHosting(this, "ParticipantPortal");
      const baseConfig =
        props.participantPortal.runtimeConfig === "default-dev-mock"
          ? DEFAULT_DEV_MOCK_RUNTIME_CONFIG(this.region)
          : props.participantPortal.runtimeConfig;
      const runtimeConfig: ParticipantPortalRuntimeConfig = {
        ...baseConfig,
        apiBaseUrl: portalLambda.url.url,
        mode: "backend",
      };
      portal.deployRuntimeConfig(runtimeConfig);
      this.participantPortalUrl = portal.distributionUrl;
      new CfnOutput(this, "ParticipantPortalUrl", {
        value: portal.distributionUrl,
        description: "Participant Portal CloudFront URL.",
      });
    }

    this.deploymentsTableName = deployments.table.tableName;
    this.deploymentsTableArn = deployments.table.tableArn;

    new CfnOutput(this, "DeploymentsTableName", {
      value: deployments.table.tableName,
      description: "Deploy ジョブを記録する DynamoDB テーブル名。",
    });
    new CfnOutput(this, "DeployCreateStateMachineArn", {
      value: stateMachine.stateMachine.stateMachineArn,
      description: "Deploy 起動を司る Step Functions State Machine の ARN。",
    });
  }
}
