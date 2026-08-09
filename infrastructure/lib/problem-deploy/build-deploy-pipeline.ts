import * as path from "node:path";
import type { IProject } from "aws-cdk-lib/aws-codebuild";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { ILogGroup } from "aws-cdk-lib/aws-logs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import type { PackAsset } from "../app-config/types.js";
import { deploymentLogGroup } from "../utils/deployment-log-group.js";
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
import { DeployStatusWriterLambda } from "./deploy-status-writer-lambda.js";
import { DescribeStackLambda } from "./describe-stack-lambda.js";

export interface BuildDeployPipelineArgs {
  /**
   * [Issue #2441 / Phase B PR-6] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合
   * `DeployStatusWriterLambda` が生成され、DeployCreate/DeployDelete 双方の SFN 書き戻しは
   * Lambda invoke 経由になる (= 本 table を参照しない)。
   */
  readonly deploymentsTable?: Table;
  readonly eventBus: IEventBus;
  readonly bulkPayloadBucket: Bucket;
  readonly sourceBucketName: string;
  readonly sourceObjectKey: string;
  readonly deployConcurrentBuildLimit?: number;
  readonly environmentName: string;
  /** Score-engine / operator-attacker egress CIDRs for problem templates declaring AllowedCidr. */
  readonly deployAllowedCidrs?: readonly string[];
  /**
   * Issue #2291 (ADR-049 §9): true のとき DeployCreate を Lambda CreateStack + DescribeStacks
   * poll 経路にし、専用 {@link CfnDeployLambda} を生成する。default (false / 未指定) は在来の
   * CodeBuild 経路で、追加リソースなし = CFn テンプレ byte 互換。
   */
  readonly deployViaLambda?: boolean;
  /**
   * [Issue #2441 Phase B PR-5] Control-data backend selector. Pure SQL
   * (`turso`) swaps DeployCreate's SFN status writes to
   * DeployStatusWriterLambda; the default (dynamodb) mode keeps native DDB writes.
   */
  readonly controlDataBackend?: string;
  readonly tursoDatabaseUrl?: string;
  readonly tursoAuthTokenParameterName?: string;
  /**
   * [Problem Packs / Issue #2462] Installed + active pack revisions to materialize alongside the
   * core `problems/` tree (Lite only; resolved from `.tenkacloud/pack-store`). Each entry gets a
   * `BucketDeployment` copying its snapshot problems root into `pack-problems/<packId>/<version>/…`.
   * Only consumed on the Lambda deploy path (`deployViaLambda`); undefined / empty (the default and
   * SaaS — pooled activation wiring is #2459) adds no resource = CFn byte-identical.
   */
  readonly packAssets?: readonly PackAsset[];
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
 * the CodeBuild project / state machines). `bulkPayloadBucket` is created by the API Lambda
 * family builder (`build-api-lambdas.ts` — EventApiLambda PutObjects into it), not here.
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
/**
 * Issue #2462: CDK-safe, per-pack construct id fragment. The reverse-DNS `packId` and dotted
 * `version` carry `.`/`-` that are stripped from CFn logical ids, so `<packId>` + `<version>` are
 * normalized to `[A-Za-z0-9]` runs joined by `-`. The fragment stays UNIQUE per (packId, version)
 * — a collision would make CDK throw on duplicate sibling ids (fail-loud, not a silent overwrite).
 */
function packAssetConstructId(asset: PackAsset): string {
  const normalize = (value: string): string => value.replace(/[^A-Za-z0-9]+/g, "-");
  return `${normalize(asset.packId)}-${normalize(asset.version)}`;
}

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
      deployAllowedCidrs: args.deployAllowedCidrs,
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
      logGroup: deploymentLogGroup(scope, "ProblemArtifactsLogs"),
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

    // Issue #2462: materialize each active pack's immutable snapshot problems root NEXT TO the core
    // tree, under `pack-problems/<packId>/<version>/`. `packAssets[].problemsRootAbs` is the pack's
    // problems root, so its `<category>/<id>/{template.yaml,metadata.json}` children land at
    // `pack-problems/<packId>/<version>/<category>/<id>/…` — byte-for-byte the directory keys the
    // catalog emits (`buildPackProblemDirectory`) and the resolver reads (create-stack.ts). Empty /
    // undefined (default core-only, and SaaS pooled which is #2459) adds no resource = byte-identical.
    //
    // Known scope limits (this slice is Lite `make deploy` only):
    //   - Scoring/endpoints/phases/visibility/runtimes/disruptions/writeups projections ARE now
    //     composed into the effective bundle (`catalog-source.ts` `SnapshotCatalogSource`, #2463) —
    //     a pack is no longer catalog + deploy body only.
    //   - The store's bytes DO travel in the CodeBuild deploy path's `source.zip` since #2505
    //     (`scripts/package-source-bundle.sh`), but nothing on the SaaS/CodeBuild synth path
    //     consumes them (`bin/infrastructure.ts` passes no catalog source), and a SaaS synth with
    //     any pack activation present now fails loud instead of silently ignoring them
    //     (`saas-pack-guard.ts`, #2459). Pack problems remain Lambda-path (`deployViaLambda`) only,
    //     which is why this loop lives inside the `deployViaLambda` branch.
    //
    // prune:false is MANDATORY for the same reason as the core deployment above (the source bucket
    // also holds source.zip + the core `problems/` tree). Each pack targets a DISTINCT key prefix, so
    // packs never clobber the core tree or each other.
    for (const asset of args.packAssets ?? []) {
      new BucketDeployment(scope, `PackArtifacts-${packAssetConstructId(asset)}`, {
        logGroup: deploymentLogGroup(scope, `PackArtifactsLogs-${packAssetConstructId(asset)}`),
        sources: [Source.asset(asset.problemsRootAbs, { exclude: ["node_modules"] })],
        destinationBucket: sourceBucket,
        destinationKeyPrefix: `pack-problems/${asset.packId}/${asset.version}`,
        prune: false,
        memoryLimit: 256,
      });
    }
  }

  const pureSqlBackend = args.controlDataBackend === "turso";
  const statusWriter = pureSqlBackend
    ? new DeployStatusWriterLambda(scope, "DeployStatusWriter", {
        deploymentsTable: args.deploymentsTable,
        controlDataBackend: args.controlDataBackend,
        tursoDatabaseUrl: args.tursoDatabaseUrl,
        tursoAuthTokenParameterName: args.tursoAuthTokenParameterName,
      })
    : undefined;

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
    ...(statusWriter ? { statusWriterFunction: statusWriter.fn } : {}),
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
    // [Issue #2441 Phase B PR-6] pure SQL のときは DeployCreate と同じ DeployStatusWriterLambda
    // を共用する (別 Lambda は作らない; MarkDeleted/MarkFailed が transition name で分岐)。
    ...(statusWriter ? { statusWriterFunction: statusWriter.fn } : {}),
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
