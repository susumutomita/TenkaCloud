import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import { Bucket } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { BulkDeployCreateStateMachine } from "./bulk-deploy-create-state-machine.js";
import { DeployCodeBuildProject } from "./deploy-codebuild-project.js";
import { DeployCreateStateMachine } from "./deploy-create-state-machine.js";
import { DeployDeleteStateMachine } from "./deploy-delete-state-machine.js";
import {
  BulkDeployCreateEventRule,
  DeployDeleteEventRule,
  DeployEventRule,
} from "./deploy-event-rule.js";
import { DescribeStackLambda } from "./describe-stack-lambda.js";

export interface BuildDeployPipelineArgs {
  readonly deploymentsTable: Table;
  readonly eventBus: IEventBus;
  readonly bulkPayloadBucket: Bucket;
  readonly sourceBucketName: string;
  readonly sourceObjectKey: string;
  readonly deployConcurrentBuildLimit?: number;
  readonly environmentName: string;
}

export interface DeployPipelineOutputs {
  readonly deployCodeBuildProjectName: string;
  readonly deployCreateStateMachineArn: string;
  readonly deployDeleteStateMachineArn: string;
  readonly bulkDeployPayloadBucketName: string;
  readonly bulkDeployCreateStateMachineArn: string;
}

/**
 * Issue #2220: extracted verbatim from `ProblemDeployBackendStack`'s constructor
 * (formerly lines 413-468) to shrink the constructor. `scope` MUST be the stack instance
 * itself (all construct IDs below are unprefixed, exactly as they were inline) — moving this
 * to a nested construct would change every logical ID beneath it (data-loss-class REPLACE on
 * the CodeBuild project / state machines). `bulkPayloadBucket` is created by the caller
 * (it's also used by EventApiLambda, wired before this pipeline in the constructor), not here.
 *
 * CodeBuild Project: source.zip から `scripts/deploy-battles.sh` を実行する。
 * #538: Bulk Deploy 並列度の hard cap は account-wide CodeBuild concurrent build quota
 * (region default 60)。本 prop で project 単位に明示 cap を指定できる (= operator が Service
 * Quota を引き上げた値を伝える経路 / sandbox で暴走防止)。
 *
 * 削除経路 (deploy 対称): `DeployDeleteRequested` → DeployDelete State Machine → 同 CodeBuild
 * Project (`OPERATION=delete`) → `scripts/delete-battles.sh` → CFn DeleteStack。 State Machine
 * 完了で DDB の status を `DELETING` → `DELETED` / `FAILED` に書き戻す。
 *
 * Issue #910 (#895 Phase 2.C): Distributed Map state machine + EventBridge Rule。
 */
export function buildDeployPipeline(
  scope: Construct,
  args: BuildDeployPipelineArgs,
): DeployPipelineOutputs {
  const sourceBucket = Bucket.fromBucketName(scope, "SourceBucket", args.sourceBucketName);
  const codeBuild = new DeployCodeBuildProject(scope, "DeployCodeBuild", {
    sourceBucket,
    sourceObjectKey: args.sourceObjectKey,
    concurrentBuildLimit: args.deployConcurrentBuildLimit,
    environmentName: args.environmentName,
  });

  const describeStack = new DescribeStackLambda(scope, "DescribeStack", {
    environmentName: args.environmentName,
  });

  const stateMachine = new DeployCreateStateMachine(scope, "DeployCreate", {
    codeBuildProject: codeBuild.project,
    describeStackFunction: describeStack.fn,
    deploymentsTable: args.deploymentsTable,
  });

  // EventBridge Rule: `DeployCreateRequested` event を State Machine に流す。
  new DeployEventRule(scope, "DeployCreateRule", {
    eventBus: args.eventBus,
    stateMachine: stateMachine.stateMachine,
  });

  const deleteStateMachine = new DeployDeleteStateMachine(scope, "DeployDelete", {
    codeBuildProject: codeBuild.project,
    deploymentsTable: args.deploymentsTable,
  });
  new DeployDeleteEventRule(scope, "DeployDeleteRule", {
    eventBus: args.eventBus,
    stateMachine: deleteStateMachine.stateMachine,
  });

  // Issue #910 (#895 Phase 2.C): Distributed Map state machine + EventBridge Rule。
  // bulkPayloadBucket は caller 側で EventApiLambda 用に先行生成済 (= bucket logical ID 維持)。
  const bulkStateMachine = new BulkDeployCreateStateMachine(scope, "BulkDeployCreate", {
    childStateMachine: stateMachine.stateMachine,
    payloadBucket: args.bulkPayloadBucket,
  });
  new BulkDeployCreateEventRule(scope, "BulkDeployCreateRule", {
    eventBus: args.eventBus,
    stateMachine: bulkStateMachine.stateMachine,
  });

  return {
    deployCodeBuildProjectName: codeBuild.project.projectName,
    deployCreateStateMachineArn: stateMachine.stateMachine.stateMachineArn,
    deployDeleteStateMachineArn: deleteStateMachine.stateMachine.stateMachineArn,
    bulkDeployPayloadBucketName: args.bulkPayloadBucket.bucketName,
    bulkDeployCreateStateMachineArn: bulkStateMachine.stateMachine.stateMachineArn,
  };
}
