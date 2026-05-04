import * as cdk from "aws-cdk-lib";
import { CfnOutput } from "aws-cdk-lib";
import { EventBus } from "aws-cdk-lib/aws-events";
import type { Construct } from "constructs";
import { type DeployApiCognito, DeployApiGateway } from "./deploy-api-gateway";
import { DeployApiLambda } from "./deploy-api-lambda";
import { DeployWorkerLambda } from "./deploy-worker-lambda";
import { DeployWorkerRole } from "./deploy-worker-role";
import { DeploymentsTable } from "./deployments-table";
import {
  ParticipantPortalHosting,
  type ParticipantPortalRuntimeConfig,
} from "./participant-portal-hosting";
import { StatusUpdaterLambda } from "./status-updater-lambda";

export interface ProblemDeployBackendStackProps extends cdk.StackProps {
  /**
   * SBT ControlPlane の EventBus ARN。Deploy 系イベントを流す。
   */
  readonly eventBusArn: string;
  /**
   * Deploy API Lambda が `DEFAULT_TENANT_ID` env として受け取るテナント ID。
   * 本番経路 (HTTP API + Cognito) では JWT claim を使うので、ここは Function URL
   * 直叩き経路 (ops / 開発) のフォールバック値。
   */
  readonly defaultTenantId?: string;
  /**
   * 競技者 Bootstrap CFn (PR-A) で運営者と共有された ExternalId。
   * Worker Lambda が AssumeRole 時の sts:ExternalId として渡す。Confused Deputy 対策。
   */
  readonly deployExternalId: string;
  /**
   * 競技者側 IAM Role 名 (PR-A の default と一致させる)。省略時は規約通り。
   */
  readonly competitorRoleName?: string;
  /**
   * Deploy API HTTP API の手前に置く Cognito JWT authorizer 設定。
   * 指定された場合のみ HTTP API を作成する。単一 User Pool 信頼。
   */
  readonly deployApiCognito?: DeployApiCognito;
  /**
   * HTTP API CORS で許可する origins。UI が CloudFront / localhost dev から
   * fetch するため必須。
   */
  readonly deployApiCorsOrigins?: readonly string[];
  /**
   * 競技者向け Participant Portal を S3 + CloudFront で配信するかのフラグ。
   * `true` のとき `ParticipantPortalHosting` を作成、`runtimeConfig` で
   * runtime-config.json を初期配置する。
   */
  readonly enableParticipantPortal?: boolean;
  /**
   * Participant Portal の runtime-config.json に書き出す値。
   * `enableParticipantPortal` が `true` のときのみ参照される。
   * 未指定時は `mode="dev-mock"` のサンプル値が入る (Portal backend が無い段階用)。
   */
  readonly participantPortalRuntimeConfig?: ParticipantPortalRuntimeConfig;
}

/**
 * 問題 deploy backend のスタック。
 *
 * - Deployments テーブル (DDB)
 * - Deploy Worker IAM Role (cross-account AssumeRole + DDB + EventBus)
 * - Deploy API Lambda + Function URL (POST /problems/:id/deploy)
 * - Deploy Worker Lambda + EventBridge Rule (DeployRequested → AssumeRole + CFn)
 */
export class ProblemDeployBackendStack extends cdk.Stack {
  public readonly deploymentsTableName: string;
  public readonly deploymentsTableArn: string;
  public readonly deployWorkerRoleArn: string;
  public readonly deployApiUrl: string;
  public readonly deployApiGatewayUrl?: string;
  public readonly participantPortalUrl?: string;

  constructor(scope: Construct, id: string, props: ProblemDeployBackendStackProps) {
    super(scope, id, props);

    const deployments = new DeploymentsTable(this, "Deployments");
    const workerRole = new DeployWorkerRole(this, "WorkerRole", {
      deploymentsTableArn: deployments.table.tableArn,
      eventBusArn: props.eventBusArn,
    });

    const eventBus = EventBus.fromEventBusArn(this, "ImportedEventBus", props.eventBusArn);

    const deployApi = new DeployApiLambda(this, "DeployApi", {
      deploymentsTableName: deployments.table.tableName,
      eventBusName: eventBus.eventBusName,
      executionRole: workerRole.role,
      defaultTenantId: props.defaultTenantId,
    });

    new DeployWorkerLambda(this, "DeployWorker", {
      deploymentsTableName: deployments.table.tableName,
      eventBus,
      executionRole: workerRole.role,
      externalId: props.deployExternalId,
      competitorRoleName: props.competitorRoleName,
    });

    new StatusUpdaterLambda(this, "StatusUpdater", {
      deploymentsTableName: deployments.table.tableName,
      eventBus,
      executionRole: workerRole.role,
      externalId: props.deployExternalId,
      competitorRoleName: props.competitorRoleName,
    });

    if (props.deployApiCognito) {
      const apiGw = new DeployApiGateway(this, "DeployApiGateway", {
        cognito: props.deployApiCognito,
        deployHandler: deployApi.fn,
        corsAllowOrigins: props.deployApiCorsOrigins ?? ["*"],
      });
      this.deployApiGatewayUrl = apiGw.httpApi.apiEndpoint;
    }

    if (props.enableParticipantPortal) {
      const portal = new ParticipantPortalHosting(this, "ParticipantPortal");
      portal.deployRuntimeConfig(
        props.participantPortalRuntimeConfig ?? {
          eventTitle: "TenkaCloud Battle",
          eventRegion: this.region,
          mode: "dev-mock",
        },
      );
      this.participantPortalUrl = portal.distributionUrl;
      new CfnOutput(this, "ParticipantPortalUrl", {
        value: portal.distributionUrl,
        description: "Participant Portal CloudFront URL.",
      });
    }

    this.deploymentsTableName = deployments.table.tableName;
    this.deploymentsTableArn = deployments.table.tableArn;
    this.deployWorkerRoleArn = workerRole.role.roleArn;
    this.deployApiUrl = deployApi.url.url;

    new CfnOutput(this, "DeploymentsTableName", {
      value: deployments.table.tableName,
      description: "Deploy ジョブを記録する DynamoDB テーブル名。",
    });
    new CfnOutput(this, "DeployWorkerRoleArn", {
      value: workerRole.role.roleArn,
      description: "Deploy 系 Lambda が引き受ける IAM Role の ARN。",
    });
    new CfnOutput(this, "DeployApiUrl", {
      value: deployApi.url.url,
      description: "Deploy API Lambda の Function URL。AWS_IAM 認証。",
    });
  }
}
