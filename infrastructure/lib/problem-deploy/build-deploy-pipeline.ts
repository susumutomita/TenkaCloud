import * as path from "node:path";
import type { IProject } from "aws-cdk-lib/aws-codebuild";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { ILogGroup } from "aws-cdk-lib/aws-logs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { BulkDeployCreateStateMachine } from "./bulk-deploy-create-state-machine.js";
import { CfnDeployLambda } from "./cfn-deploy-lambda.js";
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
  /**
   * Issue #2291 (ADR-049 §9): true のとき DeployCreate を Lambda CreateStack + DescribeStacks
   * poll 経路にし、専用 {@link CfnDeployLambda} を生成する。default (false / 未指定) は在来の
   * CodeBuild 経路で、追加リソースなし = CFn テンプレ byte 互換。
   */
  readonly deployViaLambda?: boolean;
}

export interface DeployPipelineOutputs {
  readonly deployCodeBuildProjectName?: string;
  readonly deployCodeBuildProject?: IProject;
  readonly deployCreateStateMachineArn: string;
  readonly deployDeleteStateMachineArn: string;
  readonly bulkDeployPayloadBucketName: string;
  readonly bulkDeployCreateStateMachineArn: string;
  readonly deployJobLogGroup?: ILogGroup;
  /**
   * Issue #2291: the Lambda deploy path's `CfnDeployLambda` function name. Present only when
   * `deployViaLambda` is ON (the {@link CfnDeployLambda} that owns it is created only then).
   * Threaded to the ObservabilityStack so the dashboard can plot a Lambda-path deploy widget
   * (Invocations / Errors / Duration / Throttles). `undefined` on the default CodeBuild path
   * (flag OFF) → the observability dashboard adds no CfnDeploy widget (default-safe / byte-identical).
   */
  readonly cfnDeployLambdaName?: string;
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
  let codeBuild: DeployCodeBuildProject | undefined;
  if (!args.deployViaLambda) {
    codeBuild = new DeployCodeBuildProject(scope, "DeployCodeBuild", {
      sourceBucket,
      sourceObjectKey: args.sourceObjectKey,
      concurrentBuildLimit: args.deployConcurrentBuildLimit,
      environmentName: args.environmentName,
    });
  }

  const describeStack = new DescribeStackLambda(scope, "DescribeStack", {
    environmentName: args.environmentName,
  });

  // Issue #2291: flag ON のときだけ deploy Lambda を生成し、create/delete の両経路から
  // CodeBuild を除去する。flag OFF の synth は CfnDeploy 構築が無く従来どおり。
  let cfnDeployFunction: IFunction | undefined;
  let deployJobLogGroup: ILogGroup | undefined;
  if (args.deployViaLambda) {
    const cfnDeploy = new CfnDeployLambda(scope, "CfnDeploy", {
      environmentName: args.environmentName,
      sourceBucketName: args.sourceBucketName,
    });
    cfnDeployFunction = cfnDeploy.fn;
    deployJobLogGroup = cfnDeploy.deploymentLogGroup;
    describeStack.fn.addEnvironment(
      "DEPLOYMENT_LOG_GROUP_NAME",
      cfnDeploy.deploymentLogGroup.logGroupName,
    );
    cfnDeploy.deploymentLogGroup.grantWrite(describeStack.fn);

    // Issue #2291 (ADR-049 §9): materialize the repo `problems/` tree (un-zipped) into the
    // source bucket so `buildS3ArtifactsResolver` (create-stack.ts) can GetObject
    // `${detail.problemDir}/template.yaml` + `${detail.problemDir}/metadata.json`. `problemDir`
    // is validated as `problems/<category>/<id>` (events.ts `DeployCreateRequestedDetailSchema`),
    // so uploading `problems/`'s contents under the `problems/` key prefix lands the objects at
    // `problems/<category>/<id>/{template.yaml,metadata.json}` — byte-for-byte the on-disk layout
    // `deploy-battles.sh` reads. Gated on `deployViaLambda`, so the default (flag OFF) synth adds
    // no BucketDeployment and stays byte-identical. Copying the whole tree (rather than filtering
    // to just the two files) is deliberate: the default GLOB ignore strategy cannot re-include a
    // nested file whose parent directory is excluded, so a `!**/template.yaml` filter would skip
    // the very files we need. The tree is small (~1.7MB) once `node_modules` is excluded, and the
    // resolver only ever reads the two keys above, so the extra docs/schema objects are inert.
    //
    // prune:false is MANDATORY. The source bucket ALSO holds `source.zip` (the CodeBuild deploy
    // bundle, uploaded by install.sh) and other objects. BucketDeployment's default prune:true
    // deletes every object in the destination that is not part of this asset — that would wipe
    // source.zip and break the CodeBuild deploy/delete path. Never remove prune:false here.
    new BucketDeployment(scope, "ProblemArtifacts", {
      sources: [
        Source.asset(path.resolve(import.meta.dirname, "../../../problems"), {
          // Exclude the catalog's dev dependencies: large and irrelevant to the deploy body.
          // (A positive directory exclude has no glob re-include pitfall.)
          exclude: ["node_modules"],
        }),
      ],
      destinationBucket: sourceBucket,
      destinationKeyPrefix: "problems",
      prune: false,
      // The copy handler unzips + `aws s3 sync`s the tree; 256MB comfortably covers the small tree.
      memoryLimit: 256,
    });
  }

  const stateMachine = new DeployCreateStateMachine(scope, "DeployCreate", {
    codeBuildProject: codeBuild?.project,
    describeStackFunction: describeStack.fn,
    deploymentsTable: args.deploymentsTable,
    // flag OFF では以下 prop は undefined = CodeBuild 定義を生成 (在来と同一、追加リソースなし)。
    // flag ON では Lambda 経路 + 失敗時の `TenkaCloud Deploy Failed` PutEvents を有効化するため
    // 共通 EventBus を渡す (= SystemAuditWriterLambda が同 bus 上で拾う、Issue #2291)。
    ...(args.deployViaLambda
      ? { deployViaLambda: true, cfnDeployFunction, eventBus: args.eventBus }
      : {}),
  });

  // EventBridge Rule: `DeployCreateRequested` event を State Machine に流す。
  new DeployEventRule(scope, "DeployCreateRule", {
    eventBus: args.eventBus,
    stateMachine: stateMachine.stateMachine,
  });

  const deleteStateMachine = new DeployDeleteStateMachine(scope, "DeployDelete", {
    codeBuildProject: codeBuild?.project,
    deploymentsTable: args.deploymentsTable,
    // Issue #2291: flag OFF では以下 2 prop は undefined = CodeBuild 定義を生成 (在来と同一、
    // 追加リソースなし)。flag ON では create path と同じ CfnDeployLambda を共用する (別 Lambda
    // は作らない; index.ts が action で create / delete を分岐)。
    ...(args.deployViaLambda ? { deployViaLambda: true, cfnDeployFunction } : {}),
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
    deployCodeBuildProjectName: codeBuild?.project.projectName,
    deployCodeBuildProject: codeBuild?.project,
    deployCreateStateMachineArn: stateMachine.stateMachine.stateMachineArn,
    deployDeleteStateMachineArn: deleteStateMachine.stateMachine.stateMachineArn,
    bulkDeployPayloadBucketName: args.bulkPayloadBucket.bucketName,
    bulkDeployCreateStateMachineArn: bulkStateMachine.stateMachine.stateMachineArn,
    // #2291: undefined on the default CodeBuild path (flag OFF) → no participant read grant added.
    ...(deployJobLogGroup ? { deployJobLogGroup } : {}),
    // #2291: surface the Lambda-path deploy function name for ObservabilityStack. undefined on the
    // default CodeBuild path (flag OFF) → dashboard adds no CfnDeploy widget (default-safe).
    ...(cfnDeployFunction ? { cfnDeployLambdaName: cfnDeployFunction.functionName } : {}),
  };
}
