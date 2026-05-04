import * as cdk from "aws-cdk-lib";
import { CfnOutput } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { DeployWorkerRole } from "./deploy-worker-role";
import { DeploymentsTable } from "./deployments-table";

export interface ProblemDeployBackendStackProps extends cdk.StackProps {
  /**
   * SBT ControlPlane の EventBus ARN。Deploy 系イベント (DeployRequested /
   * DeployStarted / DeployCompleted / DeployFailed) を流す。後段 PR で
   * EventBridge Rule を本 stack に追加する。
   */
  readonly eventBusArn: string;
}

/**
 * 問題 deploy backend のスタック。
 *
 * 本 PR (PR-B) ではまだ Lambda は無く、後続 PR (C-G) が必要とする土台:
 *   - Deployments テーブル (DDB)
 *   - Deploy Worker IAM Role (cross-account AssumeRole + DDB + EventBus)
 * のみを置く。EventBridge Rule + Lambda は target が同時に landing する形で
 * 後段 PR が追加する。
 */
export class ProblemDeployBackendStack extends cdk.Stack {
  public readonly deploymentsTableName: string;
  public readonly deploymentsTableArn: string;
  public readonly deployWorkerRoleArn: string;

  constructor(scope: Construct, id: string, props: ProblemDeployBackendStackProps) {
    super(scope, id, props);

    const deployments = new DeploymentsTable(this, "Deployments");
    const workerRole = new DeployWorkerRole(this, "WorkerRole", {
      deploymentsTableArn: deployments.table.tableArn,
      eventBusArn: props.eventBusArn,
    });

    this.deploymentsTableName = deployments.table.tableName;
    this.deploymentsTableArn = deployments.table.tableArn;
    this.deployWorkerRoleArn = workerRole.role.roleArn;

    new CfnOutput(this, "DeploymentsTableName", {
      value: deployments.table.tableName,
      description:
        "Deploy ジョブを記録する DynamoDB テーブル名。後段 PR の Lambda が読み書きする。",
    });
    new CfnOutput(this, "DeployWorkerRoleArn", {
      value: workerRole.role.roleArn,
      description: "後段 PR で作成する Lambda が引き受ける IAM Role の ARN。",
    });
  }
}
