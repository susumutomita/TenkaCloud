import * as cdk from "aws-cdk-lib";
import { CfnOutput } from "aws-cdk-lib";
import { EventBus } from "aws-cdk-lib/aws-events";
import type { Construct } from "constructs";
import { DeployApiLambda } from "./deploy-api-lambda";
import { DeployWorkerRole } from "./deploy-worker-role";
import { DeploymentsTable } from "./deployments-table";

export interface ProblemDeployBackendStackProps extends cdk.StackProps {
  /**
   * SBT ControlPlane の EventBus ARN。Deploy 系イベント (DeployRequested /
   * DeployStarted / DeployCompleted / DeployFailed) を流す。後段 PR で
   * EventBridge Rule を本 stack に追加する。
   */
  readonly eventBusArn: string;
  /**
   * Deploy API Lambda が `DEFAULT_TENANT_ID` env として受け取るテナント ID。
   * PR-C 暫定実装で、Cognito JWT authorizer 結線時に削除する。
   */
  readonly defaultTenantId?: string;
}

/**
 * 問題 deploy backend のスタック。
 *
 * - Deployments テーブル (DDB) — PR-B
 * - Deploy Worker IAM Role — PR-B
 * - Deploy API Lambda + Function URL (POST /problems/:id/deploy) — PR-C
 *
 * EventBridge Rule + DeployWorker Lambda は PR-D 以降で本 stack に追加する。
 */
export class ProblemDeployBackendStack extends cdk.Stack {
  public readonly deploymentsTableName: string;
  public readonly deploymentsTableArn: string;
  public readonly deployWorkerRoleArn: string;
  public readonly deployApiUrl: string;

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
      deploymentsTableArn: deployments.table.tableArn,
      eventBusName: eventBus.eventBusName,
      eventBusArn: props.eventBusArn,
      defaultTenantId: props.defaultTenantId,
    });

    this.deploymentsTableName = deployments.table.tableName;
    this.deploymentsTableArn = deployments.table.tableArn;
    this.deployWorkerRoleArn = workerRole.role.roleArn;
    this.deployApiUrl = deployApi.url.url;

    new CfnOutput(this, "DeploymentsTableName", {
      value: deployments.table.tableName,
      description:
        "Deploy ジョブを記録する DynamoDB テーブル名。後段 PR の Lambda が読み書きする。",
    });
    new CfnOutput(this, "DeployWorkerRoleArn", {
      value: workerRole.role.roleArn,
      description: "後段 PR で作成する Lambda が引き受ける IAM Role の ARN。",
    });
    new CfnOutput(this, "DeployApiUrl", {
      value: deployApi.url.url,
      description:
        "Deploy API Lambda の Function URL。AWS_IAM 認証 (PR-C 暫定)。frontend は SigV4 で叩く。",
    });
  }
}
