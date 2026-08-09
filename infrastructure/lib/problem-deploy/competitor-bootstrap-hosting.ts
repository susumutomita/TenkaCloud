import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { deploymentLogGroup } from "../utils/deployment-log-group.js";

/**
 * Issue #1053: 競技者向け CFn bootstrap template (`competitor-bootstrap.yaml`) の public S3 host。
 *
 * 旧実装は `AdminConsoleHostingStack` (= System Admin SPA hosting、 SaaS-only stack) 内に同居
 * していたため、 Lite mode (= AdminConsoleHosting を deploy しない) では template が S3 に
 * 置かれず、 frontend は GitHub raw URL fallback (= CFn が `TemplateURL must be a supported URL`
 * で reject) を使うしかなかった。 SaaS mode でも 3-phase env-var dance に依存していて
 * Phase 3 失敗時には fragile。
 *
 * 本 construct を `ProblemDeployBackendStack` (= Lite / SaaS 両モードが無条件で deploy)
 * 内に置き、 owner を 「問題 deploy 機構の asset」 という正しい責務に揃える。 consumer
 * (AdminConsoleHosting / ApplicationAdminConsoleHosting) は cross-stack ref で URL を import。
 *
 * yaml 自体は公開 repo にあり secret は含まないため public-read で OK (= GitHub raw との冗長複製)。
 * deploy 毎に最新 checkout の yaml が S3 に sync される (= GitHub raw と異なり、 merge 後の
 * 再 deploy が無くても CFn console 経路は最新を引く)。
 */
export class CompetitorBootstrapHosting extends Construct {
  /**
   * `competitor-bootstrap.yaml` の S3 virtual-hosted style URL (= CFn `TemplateURL` 要件)。
   * region を明示的に path に含め、 bucketName は deploy 時に動的解決される。 同 stack 配下の
   * consumer は CFn token として扱う、 cross-stack consumer は CfnOutput / public readonly で
   * 受け取る。
   */
  public readonly templateUrl: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const templateBucket = new Bucket(this, "Bucket", {
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: new BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      }),
      publicReadAccess: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new BucketDeployment(this, "Deployment", {
      logGroup: deploymentLogGroup(this, "DeploymentLogs"),
      sources: [
        Source.asset(path.join(import.meta.dirname, "..", "..", "templates"), {
          exclude: ["*", "!competitor-bootstrap.yaml"],
        }),
      ],
      destinationBucket: templateBucket,
      prune: false,
    });

    this.templateUrl = `https://${templateBucket.bucketName}.s3.${cdk.Stack.of(this).region}.amazonaws.com/competitor-bootstrap.yaml`;
  }
}
